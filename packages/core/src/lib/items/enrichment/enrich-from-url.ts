// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Link-based item enrichment.
 *
 * Given a dropped URL and an item type, this either:
 *  - returns just the link (when no AI provider is connected), or
 *  - fetches the linked page, asks the connected AI to extract structured
 *    field values + custom attributes, validates them, and returns suggestions.
 *
 * The client merges the suggestions into empty / still-default form fields and
 * always stores the source URL as a `link` custom attribute.
 *
 * Modeled on `src/lib/cad-generation/assessment.ts` (prompt -> JSON -> parse).
 */

import { chat } from '@tanstack/ai'
import { z } from 'zod'
import { assertSafeUrl, fetchPageText } from './html-to-text'
import type { FetchedPage } from './html-to-text'
import { getAdapter, isAIEnabled, loadProviderConfig } from '@/lib/ai/adapters'
import { UsageAccumulator, recordLlmUsage } from '@/lib/ai/usage'
import { ValidationError } from '@/lib/errors'

export type EnrichableItemType = 'Part' | 'Tool'

export interface ItemEnrichmentResult {
  aiEnabled: boolean
  /** The source URL, always returned so the caller can save it as provenance. */
  link: string
  /** Validated field suggestions keyed by form field name. */
  fields: Record<string, unknown>
  /** Extra metadata suggestions as string key/value pairs. */
  attributes: Record<string, string>
  /**
   * Set when the extraction produced more attributes than `MAX_ATTRIBUTES` and
   * the surplus was dropped. Surfaced rather than trimmed in silence so the
   * caller can say so instead of presenting a partial list as complete.
   */
  attributesTruncated?: boolean
}

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

/** Per-field schemas matching the Tool form's field types. */
const toolFieldSchemas = {
  name: z.string().min(1).max(200),
  toolType: z.enum(['manufacturing', 'quality', 'utility']),
  toolSubtype: scalarString.pipe(z.string().min(1).max(50)),
  manufacturer: scalarString.pipe(z.string().max(200)),
  model: scalarString.pipe(z.string().max(200)),
  location: scalarString.pipe(z.string().max(500)),
  notes: scalarString.pipe(z.string().max(5000)),
} satisfies Record<string, z.ZodTypeAny>

const MAX_ATTRIBUTES = 20

export async function enrichItemFromUrl(params: {
  url: string
  itemType: EnrichableItemType
  /** Whose spend this is — the extraction's usage row is written against it. */
  userId: string
  /** Caller's abort signal, chained into the extraction request. */
  signal?: AbortSignal
}): Promise<ItemEnrichmentResult> {
  const { url, itemType, userId, signal } = params

  // Validate the URL early (also blocks SSRF) so a bad drop fails fast even
  // when AI is off and we would otherwise just echo the link back.
  assertSafeUrl(url)

  const aiEnabled = await isAIEnabled()
  if (!aiEnabled) {
    return { aiEnabled: false, link: url, fields: {}, attributes: {} }
  }

  let page: FetchedPage
  try {
    page = await fetchPageText(url)
  } catch (error) {
    // A blocked/invalid URL is a hard error; a merely-unreachable page still
    // lets the client save the link (AI enabled, but nothing to extract).
    if (error instanceof ValidationError) throw error
    return { aiEnabled: true, link: url, fields: {}, attributes: {} }
  }

  const raw = await runExtraction(itemType, url, page, userId, signal)
  const parsed = parseJsonResponse(raw)

  const fieldSchemas = itemType === 'Part' ? partFieldSchemas : toolFieldSchemas
  const fields = pickValidFields(fieldSchemas, parsed?.fields)
  const { attributes, truncated } = normalizeAttributes(
    parsed?.customAttributes,
  )

  return {
    aiEnabled: true,
    link: url,
    fields,
    attributes,
    attributesTruncated: truncated,
  }
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
 */
async function runExtraction(
  itemType: EnrichableItemType,
  url: string,
  page: FetchedPage,
  userId: string,
  signal?: AbortSignal,
): Promise<string> {
  const usage = new UsageAccumulator()
  const startedAt = Date.now()
  let usageProvider: { provider: string | null; model: string | null } = {
    provider: null,
    model: null,
  }

  try {
    const providerConfig = await loadProviderConfig()
    usageProvider = {
      provider: providerConfig.provider,
      model: providerConfig.model,
    }
    const adapter = getAdapter(providerConfig)

    const messages: any = [
      { role: 'system', content: buildSystemPrompt(itemType) },
      { role: 'user', content: buildUserPrompt(url, page) },
    ]

    // Own controller, aborted by the caller's signal: `chat` takes a
    // controller, not a signal.
    const abortController = new AbortController()
    if (signal) {
      if (signal.aborted) abortController.abort()
      else signal.addEventListener('abort', () => abortController.abort())
    }

    const stream = chat({ adapter, messages, maxTokens: 1024, abortController })
    let fullResponse = ''
    for await (const chunk of stream) {
      usage.observe(chunk)
      if (chunk.type === 'content' && chunk.content) {
        fullResponse = chunk.content
      }
    }
    return fullResponse
  } catch {
    // Provider/network failure — degrade gracefully to "link only".
    return ''
  } finally {
    const totals = usage.totals
    await recordLlmUsage({
      userId,
      sessionId: null,
      // No program: the item this enriches does not exist yet.
      programId: null,
      provider: usageProvider.provider,
      model: usageProvider.model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      durationMs: Date.now() - startedAt,
    })
  }
}

function buildSystemPrompt(itemType: EnrichableItemType): string {
  if (itemType === 'Part') {
    return `You extract structured information about a single physical part or component from the text of a web page (a supplier product page, datasheet, or catalog listing).

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
- Only include a field when the page clearly supports it. OMIT anything you are unsure about — never guess.
- A catalog / supplier / off-the-shelf part is almost always "Purchase".
- weight and cost values must be plain numbers as strings, with units/currency in the separate fields.
- Put manufacturer, part number / SKU / MPN, dimensions, tolerances, and other specs into customAttributes (short human labels).
- Limit customAttributes to at most ${MAX_ATTRIBUTES} of the most useful entries.
- If the page has no relevant part information, return {"fields":{},"customAttributes":{}}.`
  }

  return `You extract structured information about a single tool, machine, or piece of equipment from the text of a web page (a manufacturer product page or spec sheet).

Return ONLY valid JSON (no markdown fences) in exactly this shape:
{
  "fields": {
    "name": "concise tool/machine name",
    "toolType": "manufacturing" | "quality" | "utility",
    "toolSubtype": "short snake_case category",
    "manufacturer": "brand / maker",
    "model": "model number or name",
    "location": "only if the page states one — usually omit",
    "notes": "brief free-form notes"
  },
  "customAttributes": { "label": "value" }
}

Guidance:
- toolType: fabrication/machining/printing/welding equipment is "manufacturing"; measurement/inspection is "quality"; automation/handling/support is "utility".
- toolSubtype examples: fdm_printer, sla_printer, cnc_mill, cnc_lathe, cnc_router, laser_cutter, press_brake, mig_welder, tig_welder, drill_press, band_saw, surface_grinder, calipers, micrometer, cmm, 3d_scanner, robotic_arm. Choose the closest snake_case category.
- Only include a field when the page clearly supports it. OMIT anything you are unsure about.
- Put build volume, work area, power, spindle speed, accuracy, and other specs into customAttributes (short human labels).
- Limit customAttributes to at most ${MAX_ATTRIBUTES} of the most useful entries.
- If the page has no relevant tool information, return {"fields":{},"customAttributes":{}}.`
}

function buildUserPrompt(url: string, page: FetchedPage): string {
  const lines: Array<string> = [`Source URL: ${url}`]
  if (page.title) lines.push(`Page title: ${page.title}`)
  if (page.description) lines.push(`Meta description: ${page.description}`)
  lines.push('', 'Page text:', '"""', page.text, '"""', '')
  lines.push('Extract the item information as specified.')
  return lines.join('\n')
}

/** Strip markdown fences and isolate the JSON object; returns null on failure. */
function parseJsonResponse(response: string): {
  fields?: unknown
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
