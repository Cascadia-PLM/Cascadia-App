// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Link- and image-based item enrichment.
 *
 * Given a dropped link and/or dropped images plus an item type, this either:
 *  - returns just the link (when no AI provider is connected), or
 *  - gathers the sources (fetching a linked page or image), asks the connected
 *    AI to extract structured field values, custom attributes and — for a
 *    tool whose subtype has a capabilities shape — capabilities, validates
 *    them, and returns suggestions.
 *
 * The client merges the suggestions into empty / still-default form fields,
 * stores a source URL as a `link` custom attribute, and attaches dropped
 * images to the item once it exists.
 *
 * Modeled on `packages/design-engine/src/lib/cad-generation/assessment.ts`
 * (prompt -> JSON -> parse).
 */

import { chat } from '@tanstack/ai'
import { z } from 'zod'
import { assertSafeUrl } from './html-to-text'
import { fetchSource } from './fetch-source'
import {
  ENRICHMENT_IMAGE_MEDIA_TYPES,
  MAX_ENRICHMENT_IMAGES,
  MAX_ENRICHMENT_IMAGE_BASE64_CHARS,
} from './limits'
import type { FetchedPage } from './html-to-text'
import type { EnrichmentImage } from './limits'
import type { KnownToolSubtype } from '@/lib/items/types/tool'
import type { ProviderType } from '@/lib/ai/adapters'
import { getAdapter, isAIEnabled, loadProviderConfig } from '@/lib/ai/adapters'
import { CAPABILITY_SCHEMAS, TOOL_SUBTYPES } from '@/lib/items/types/tool'
import { UsageAccumulator, recordLlmUsage } from '@/lib/ai/usage'
import { RateLimitedError, ValidationError } from '@/lib/errors'

export type EnrichableItemType = 'Part' | 'Tool'

export interface ItemEnrichmentResult {
  aiEnabled: boolean
  /** The source URL when one was given, so the caller can save it as provenance. */
  link?: string
  /** Validated field suggestions keyed by form field name. */
  fields: Record<string, unknown>
  /** Extra metadata suggestions as string key/value pairs. */
  attributes: Record<string, string>
  /**
   * Tool only: capabilities validated against the suggested subtype's schema.
   * Present only when the subtype is known and at least one key survived.
   */
  capabilities?: Record<string, unknown>
  /**
   * Set when the extraction produced more attributes than `MAX_ATTRIBUTES` and
   * the surplus was dropped. Surfaced rather than trimmed in silence so the
   * caller can say so instead of presenting a partial list as complete.
   */
  attributesTruncated?: boolean
  /**
   * The model was called and the call failed (provider error, or a model that
   * cannot take the input it was given). Distinct from "nothing found", which
   * is a successful call with empty suggestions.
   */
  extractionFailed?: boolean
  /**
   * Why the link contributed nothing: it was valid but could not be fetched
   * (unreachable, 404, not a page). The link is still returned.
   */
  warning?: string
}

export interface EnrichItemParams {
  itemType: EnrichableItemType
  url?: string
  images?: Array<EnrichmentImage>
  /** Whose spend this is — the extraction's usage row is written against it. */
  userId: string
  /** Caller's abort signal, chained into the extraction request. */
  signal?: AbortSignal
}

/** Base64 with no data-URI prefix; the client strips it before sending. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * One dropped image as the endpoint accepts it. Exported so the route's body
 * schema and the service's own check are the same object.
 */
export const enrichmentImageSchema = z.object({
  mediaType: z.enum(ENRICHMENT_IMAGE_MEDIA_TYPES),
  data: z
    .string()
    .min(1)
    .max(MAX_ENRICHMENT_IMAGE_BASE64_CHARS, {
      message: 'That image is too large to read (4 MB limit)',
    })
    .regex(BASE64_RE, {
      message: 'Image data must be base64 without a data-URI prefix',
    }),
})

const enrichmentImagesSchema = z
  .array(enrichmentImageSchema)
  .max(MAX_ENRICHMENT_IMAGES, {
    message: `Up to ${MAX_ENRICHMENT_IMAGES} images can be read at a time`,
  })

/** Coerce scalar values to a trimmed string (AI may emit numbers for text fields). */
const scalarString = z.coerce.string().transform((value) => value.trim())

/** Per-field schemas matching the Part form's field types (weight/cost are strings). */
const partFieldSchemas = {
  name: z.string().min(1).max(200),
  description: scalarString.pipe(z.string().max(5000)),
  partType: z.enum(['Manufacture', 'Purchase', 'Software', 'Phantom']),
  material: scalarString.pipe(z.string().max(100)),
  weight: scalarString.pipe(z.string().max(50)),
  weightUnit: scalarString.pipe(z.string().max(10)),
  cost: scalarString.pipe(z.string().max(50)),
  costCurrency: scalarString.pipe(z.string().length(3)),
  leadTimeDays: z.coerce.number().int().min(0),
} satisfies Record<string, z.ZodTypeAny>

const TOOL_SUBTYPE_KEYS = Object.keys(TOOL_SUBTYPES) as [
  KnownToolSubtype,
  ...Array<KnownToolSubtype>,
]

function isKnownToolSubtype(value: string): value is KnownToolSubtype {
  return Object.hasOwn(TOOL_SUBTYPES, value)
}

/**
 * Per-field schemas matching the Tool form's field types. `toolSubtype` is
 * held to the catalog: the form's selector offers exactly those keys, so a
 * value outside them would sit in state with nothing to show for it.
 */
const toolFieldSchemas = {
  name: z.string().min(1).max(200),
  toolType: z.enum(['manufacturing', 'quality', 'utility']),
  toolSubtype: z.enum(TOOL_SUBTYPE_KEYS),
  manufacturer: scalarString.pipe(z.string().max(200)),
  model: scalarString.pipe(z.string().max(200)),
  location: scalarString.pipe(z.string().max(500)),
  notes: scalarString.pipe(z.string().max(5000)),
} satisfies Record<string, z.ZodTypeAny>

const MAX_ATTRIBUTES = 20

export async function enrichItem(
  params: EnrichItemParams,
): Promise<ItemEnrichmentResult> {
  const { itemType, url, userId, signal } = params

  // Validate the inputs early (the URL check also blocks SSRF) so a bad drop
  // fails fast even when AI is off and we would otherwise echo the link back.
  const droppedImages = validateImages(params.images ?? [])
  if (url) assertSafeUrl(url)
  if (!url && droppedImages.length === 0) {
    throw new ValidationError('Drop a link or an image to auto-fill the form')
  }

  const result: ItemEnrichmentResult = {
    aiEnabled: false,
    ...(url ? { link: url } : {}),
    fields: {},
    attributes: {},
  }

  if (!(await isAIEnabled())) return result
  result.aiEnabled = true

  let page: FetchedPage | undefined
  const images = [...droppedImages]
  if (url) {
    try {
      const source = await fetchSource(url)
      if (source.kind === 'page') {
        page = source.page
      } else if (images.length < MAX_ENRICHMENT_IMAGES) {
        // A dropped image URL — the drop came from another tab's <img>.
        images.push(source.image)
      }
    } catch (error) {
      // The URL itself passed `assertSafeUrl` above, so this is the fetch
      // failing: unreachable, a 404, not a page. The link is still worth
      // keeping; say why nothing more came of it.
      if (!(error instanceof ValidationError)) throw error
      result.warning = error.message
    }
  }

  if (!page && images.length === 0) return result

  const extraction = await runExtraction({
    itemType,
    url,
    page,
    images,
    userId,
    signal,
  })
  if (extraction.failed) return { ...result, extractionFailed: true }

  return { ...result, ...pickSuggestions(itemType, extraction.response) }
}

function validateImages(
  images: Array<EnrichmentImage>,
): Array<EnrichmentImage> {
  const parsed = enrichmentImagesSchema.safeParse(images)
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.message ?? 'Those images cannot be read',
    )
  }
  return parsed.data
}

interface ExtractionInput {
  itemType: EnrichableItemType
  url?: string
  page?: FetchedPage
  images: Array<EnrichmentImage>
  userId: string
  signal?: AbortSignal
}

/**
 * The one model call this feature makes.
 *
 * Global provider config on purpose: enrichment runs *before* the item exists,
 * so there is no program to scope it to and the global row is the honest
 * answer. The usage row is written in a `finally` and carries a null
 * `programId` for the same reason — a failed or aborted extraction still spent
 * what the provider had already billed for, and these rows are what
 * `enforceMonthlyTokenBudget` sums.
 *
 * The provider is resolved *outside* that block: a reached budget throws
 * there, before anything is spent, and has to surface as its 429 rather than
 * degrade into "nothing found" with a token-less usage row behind it.
 */
async function runExtraction(
  input: ExtractionInput,
): Promise<{ response: string; failed: boolean }> {
  const providerConfig = await loadProviderConfig()

  const usage = new UsageAccumulator()
  const startedAt = Date.now()

  try {
    const adapter = getAdapter(providerConfig)

    // Own controller, aborted by the caller's signal: `chat` takes a
    // controller, not a signal.
    const abortController = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) abortController.abort()
      else input.signal.addEventListener('abort', () => abortController.abort())
    }

    // Typed at the boundary only: `chat` constrains `messages` by the
    // adapter's declared modalities, and `getAdapter` returns a union of
    // adapters, so the multimodal content below cannot satisfy every member.
    const messages: any = [
      {
        role: 'user',
        content: buildUserContent(providerConfig.provider, input),
      },
    ]

    const stream = chat({
      adapter,
      // The system prompt goes through `systemPrompts`, which the adapters map
      // to the provider's system slot (Anthropic `system`, OpenAI
      // `instructions`). A `system`-role entry in `messages` is folded into a
      // user turn by both instead.
      systemPrompts: [buildSystemPrompt(input.itemType)],
      messages,
      maxTokens: 1500,
      abortController,
    })
    let fullResponse = ''
    for await (const chunk of stream) {
      usage.observe(chunk)
      if (chunk.type === 'content' && chunk.content) {
        fullResponse = chunk.content
      }
    }
    return { response: fullResponse, failed: false }
  } catch (error) {
    // The budget check lives in `loadProviderConfig`, above this block, but
    // is re-asserted here so the shape stays honest if that ever moves.
    if (error instanceof RateLimitedError) throw error
    // Provider/network failure, or a model that rejected the input (a
    // text-only model handed an image) — degrade gracefully to "link only".
    return { response: '', failed: true }
  } finally {
    const totals = usage.totals
    await recordLlmUsage({
      userId: input.userId,
      sessionId: null,
      // No program: the item this enriches does not exist yet.
      programId: null,
      provider: providerConfig.provider,
      model: providerConfig.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      durationMs: Date.now() - startedAt,
    })
  }
}

interface TextPart {
  type: 'text'
  content: string
}

interface ImagePart {
  type: 'image'
  source: { type: 'data' | 'url'; value: string }
  metadata?: { mediaType: string }
}

/**
 * Images first, then the instruction — the order the vision providers
 * recommend. The image part is shaped per provider because the two adapters
 * disagree about what `source.value` holds for inline data: Anthropic's wants
 * raw base64 plus the media type in `metadata`, and the OpenAI-compatible one
 * (OpenAI, Gemini, Ollama) forwards the value verbatim as `image_url`, so it
 * has to be a data URI.
 */
function buildUserContent(
  provider: ProviderType,
  input: ExtractionInput,
): Array<TextPart | ImagePart> {
  const parts: Array<TextPart | ImagePart> = input.images.map((image) =>
    provider === 'anthropic'
      ? {
          type: 'image',
          source: { type: 'data', value: image.data },
          metadata: { mediaType: image.mediaType },
        }
      : {
          type: 'image',
          source: {
            type: 'url',
            value: `data:${image.mediaType};base64,${image.data}`,
          },
        },
  )
  parts.push({ type: 'text', content: buildUserPrompt(input) })
  return parts
}

function buildUserPrompt(input: ExtractionInput): string {
  const lines: Array<string> = []
  if (input.url) lines.push(`Source URL: ${input.url}`)
  if (input.page) {
    if (input.page.title) lines.push(`Page title: ${input.page.title}`)
    if (input.page.description) {
      lines.push(`Meta description: ${input.page.description}`)
    }
    lines.push('', 'Page text:', '"""', input.page.text, '"""')
  }
  if (input.images.length > 0) {
    lines.push(
      '',
      `Attached images: ${input.images.length}. Read every legible label, nameplate, spec table and drawing note in them.`,
    )
  }
  lines.push('', 'Extract the item information as specified.')
  return lines.join('\n')
}

function buildSystemPrompt(itemType: EnrichableItemType): string {
  if (itemType === 'Part') {
    return `You extract structured information about a single physical part or component from a source: the text of a web page (a supplier product page, datasheet, or catalog listing), one or more images (a product photo, a nameplate or label, a datasheet page, a screenshot of a listing, or a drawing), or both.

Return ONLY valid JSON (no markdown fences) in exactly this shape:
{
  "fields": {
    "name": "concise part or product name",
    "description": "1-3 sentence summary",
    "partType": "Manufacture" | "Purchase" | "Software" | "Phantom",
    "material": "primary material",
    "weight": "numeric value only, no units (e.g. \\"1.5\\")",
    "weightUnit": "g | kg | lb | oz",
    "cost": "numeric price only, no currency symbol (e.g. \\"12.99\\")",
    "costCurrency": "ISO 4217 3-letter code (e.g. \\"USD\\")",
    "leadTimeDays": 0
  },
  "customAttributes": { "label": "value" }
}

Rules:
- Only include a field when the source clearly supports it. OMIT anything you are unsure about — never guess.
- Transcribe printed identifiers (part numbers, SKUs, model codes, ratings) exactly as written.
- A catalog / supplier / off-the-shelf part is almost always "Purchase".
- weight and cost values must be plain numbers as strings, with units/currency in the separate fields.
- Put manufacturer, part number / SKU / MPN, dimensions, tolerances, ratings, and other specs into customAttributes (short human labels).
- Limit customAttributes to at most ${MAX_ATTRIBUTES} of the most useful entries.
- If the source has no relevant part information, return {"fields":{},"customAttributes":{}}.`
  }

  return `You extract structured information about a single tool, machine, or piece of equipment from a source: the text of a web page (a manufacturer product page or spec sheet), one or more images (a photo of the machine, its nameplate or rating plate, a spec sheet page, or a listing screenshot), or both.

Return ONLY valid JSON (no markdown fences) in exactly this shape:
{
  "fields": {
    "name": "concise tool/machine name",
    "toolSubtype": "one of the subtypes listed below",
    "toolType": "manufacturing" | "quality" | "utility" (only when no listed subtype fits),
    "manufacturer": "brand / maker",
    "model": "model number or name",
    "location": "only if the source states one — usually omit",
    "notes": "brief free-form notes"
  },
  "capabilities": { "key": value },
  "customAttributes": { "label": "value" }
}

Guidance:
- toolSubtype MUST be one of: ${TOOL_SUBTYPE_KEYS.join(', ')}. Choose the closest; omit it if none fits.
- capabilities: only for the subtypes below, using exactly these keys and value shapes. Omit keys the source does not state.
${CAPABILITY_HINTS}
- Units: lengths in mm, temperatures in °C, spindle and motor speeds in RPM, power in W; tuples are JSON arrays in the order given.
- Only include a field when the source clearly supports it. OMIT anything you are unsure about.
- Transcribe printed identifiers (model numbers, ratings) exactly as written.
- Put work area, power, accuracy, weight, and other specs that have no capabilities key into customAttributes (short human labels).
- Limit customAttributes to at most ${MAX_ATTRIBUTES} of the most useful entries.
- If the source has no relevant tool information, return {"fields":{},"capabilities":{},"customAttributes":{}}.`
}

/**
 * One line per subtype with a capabilities schema, listing its keys and value
 * shapes — read off the schemas themselves, so the prompt cannot drift from
 * what `pickValidCapabilities` will accept.
 */
const CAPABILITY_HINTS = Object.entries(CAPABILITY_SCHEMAS)
  .flatMap(([subtype, schema]) => {
    if (!(schema instanceof z.ZodObject)) return []
    const shape = schema.shape as Record<string, z.ZodTypeAny>
    const keys = Object.entries(shape).map(
      ([key, field]) => `${key}: ${describeZodType(field)}`,
    )
    return [`  ${subtype}: ${keys.join('; ')}`]
  })
  .join('\n')

/** A compact value-shape hint for one capability field. */
function describeZodType(schema: z.ZodTypeAny): string {
  let inner: z.ZodTypeAny = schema
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  ) {
    inner = inner.unwrap() as z.ZodTypeAny
  }
  if (inner instanceof z.ZodTuple) {
    const items = inner.def.items as ReadonlyArray<z.ZodTypeAny>
    return `[${items.map(describeZodType).join(', ')}]`
  }
  if (inner instanceof z.ZodArray) {
    return `${describeZodType(inner.def.element as z.ZodTypeAny)}[]`
  }
  if (inner instanceof z.ZodEnum) {
    return (inner.options as ReadonlyArray<unknown>).map(String).join(' | ')
  }
  if (inner instanceof z.ZodUnion) {
    return (inner.options as ReadonlyArray<z.ZodTypeAny>)
      .map(describeZodType)
      .join(' | ')
  }
  if (inner instanceof z.ZodLiteral) {
    return Array.from(inner.values as Iterable<unknown>)
      .map(String)
      .join(' | ')
  }
  if (inner instanceof z.ZodBoolean) return 'true | false'
  if (inner instanceof z.ZodNumber) return 'number'
  if (inner instanceof z.ZodString) return 'string'
  return 'value'
}

/** Strip markdown fences and isolate the JSON object; returns null on failure. */
function parseJsonResponse(response: string): {
  fields?: unknown
  capabilities?: unknown
  customAttributes?: unknown
} | null {
  let cleaned = response.trim()
  if (!cleaned) return null

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    cleaned = cleaned.slice(start, end + 1)
  }

  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

type Suggestions = Pick<
  ItemEnrichmentResult,
  'fields' | 'attributes' | 'attributesTruncated' | 'capabilities'
>

function pickSuggestions(
  itemType: EnrichableItemType,
  response: string,
): Suggestions {
  const parsed = parseJsonResponse(response)
  const { attributes, truncated } = normalizeAttributes(
    parsed?.customAttributes,
  )

  if (itemType === 'Part') {
    return {
      fields: pickValidFields(partFieldSchemas, parsed?.fields),
      attributes,
      attributesTruncated: truncated,
    }
  }

  const fields = pickValidFields(toolFieldSchemas, parsed?.fields)
  const subtype = fields.toolSubtype
  let capabilities: Record<string, unknown> | undefined
  if (typeof subtype === 'string' && isKnownToolSubtype(subtype)) {
    // The catalog decides which group a subtype belongs to — the form derives
    // it the same way — so a model that files a cnc_mill under "quality" is
    // overruled rather than left to disagree with its own subtype.
    fields.toolType = TOOL_SUBTYPES[subtype].toolType
    capabilities = pickValidCapabilities(subtype, parsed?.capabilities)
  }

  return {
    fields,
    attributes,
    attributesTruncated: truncated,
    ...(capabilities && Object.keys(capabilities).length > 0
      ? { capabilities }
      : {}),
  }
}

/**
 * Validate each candidate field independently so one malformed value does not
 * discard the whole set. Unknown keys and empty values are dropped.
 */
function pickValidFields(
  schemas: Record<string, z.ZodTypeAny>,
  raw: unknown,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {}
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [key, schema] of Object.entries(schemas)) {
    if (!(key in source)) continue
    const value = source[key]
    if (value === null || value === undefined || value === '') continue

    const result = schema.safeParse(value)
    if (result.success && result.data !== undefined && result.data !== '') {
      out[key] = result.data
    }
  }

  return out
}

/**
 * Capabilities for a known subtype, validated key by key against that
 * subtype's schema — the same schema the Tool item validates on save, so
 * nothing suggested here can fail there.
 */
function pickValidCapabilities(
  subtype: KnownToolSubtype,
  raw: unknown,
): Record<string, unknown> | undefined {
  const schema = CAPABILITY_SCHEMAS[subtype]
  if (!(schema instanceof z.ZodObject)) return undefined
  const shape = schema.shape as Record<string, z.ZodTypeAny>
  return pickValidFields(shape, raw)
}

/** Coerce AI custom attributes to a bounded string->string map. */
function normalizeAttributes(raw: unknown): {
  attributes: Record<string, string>
  truncated: boolean
} {
  if (typeof raw !== 'object' || raw === null) {
    return { attributes: {}, truncated: false }
  }
  const out: Record<string, string> = {}
  let truncated = false

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_ATTRIBUTES) {
      // Only counts as truncation if something valid was actually left over
      truncated = true
      break
    }
    const trimmedKey = key.trim()
    if (!trimmedKey) continue
    if (value === null || value === undefined) continue

    const stringValue =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value)

    if (stringValue.trim()) {
      out[trimmedKey] = stringValue.trim().slice(0, 1000)
    }
  }

  return { attributes: out, truncated }
}
