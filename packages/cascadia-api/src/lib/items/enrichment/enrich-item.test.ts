// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Item enrichment — what must hold around the one model call it makes.
 *
 * Data-integrity gate, and the data is money: `ai_usage_logs` is what
 * `enforceMonthlyTokenBudget` sums, so an extraction that writes no row is
 * spend that escapes the budget rather than merely missing telemetry. This
 * one is reachable by anyone who can create a part, once per dropped link or
 * image.
 *
 * Two properties of the row are deliberate and pinned here. It carries the
 * user who dropped the source, so the spend is attributable; and it carries a
 * null program, because enrichment runs before the item exists and there is
 * no program to charge it to — global scope is the honest answer, not a
 * placeholder. The other side of the same ledger: a budget that is already
 * reached must stop the call, and must say so, rather than degrade quietly
 * into "nothing found".
 *
 * Security gate: dropped images are user-supplied bytes forwarded to a paid
 * provider, so the bounds on them hold before anything is spent.
 *
 * The rows are asserted in the database rather than on a `recordLlmUsage`
 * spy on purpose — that function swallows its own insert failures, so a spy
 * can pass while nothing lands.
 *
 * Run: npx vitest run packages/core/src/lib/items/enrichment/enrich-item.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { eq, isNull } from 'drizzle-orm'
import { MAX_ENRICHMENT_IMAGE_BASE64_CHARS } from './limits'
import type * as TanStackAi from '@tanstack/ai'
import type * as Adapters from '@/lib/ai/adapters'
import type * as FetchSource from './fetch-source'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { EnrichmentImage } from './limits'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { aiSettings, aiUsageLogs } from '@/lib/db/schema'
import { recordLlmUsage } from '@/lib/ai/usage'
import { RateLimitedError, ValidationError } from '@/lib/errors'

/** Scripted chunk that makes the stream throw where a real provider would. */
const THROW = Symbol('stream throws here')

/** Chunks the single chat() call yields. */
let chunks: Array<unknown> = []

/** The options every chat() call was made with, in order. */
let chatCalls: Array<any> = []

vi.mock('@tanstack/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackAi>()),
  chat: (options: unknown) => {
    chatCalls.push(options)
    return (async function* () {
      await Promise.resolve()
      for (const chunk of chunks) {
        if (chunk === THROW) throw new Error('provider stream terminated')
        yield chunk
      }
    })()
  },
}))

vi.mock('./fetch-source', async (importOriginal) => ({
  ...(await importOriginal<typeof FetchSource>()),
  fetchSource: () =>
    Promise.resolve({
      kind: 'page',
      page: {
        title: 'M4 Socket Head Cap Screw',
        description: 'Stainless, 16mm',
        text: 'M4 x 16mm socket head cap screw, A2 stainless, 1.9 g.',
      },
    }),
}))

vi.mock('@/lib/ai/adapters', async (importOriginal) => ({
  // `isAIEnabled` and `loadProviderConfig` stay real, so the settings row
  // seeded below is what resolves. Only the adapter is faked: a real one
  // wants a decryptable API key and nothing downstream of it runs here.
  ...(await importOriginal<typeof Adapters>()),
  getAdapter: () => ({}),
}))

// Imported after the mocks so the factories above are the ones that bind.
const { enrichItem } = await import('./enrich-item')

const contentChunk = (content: string) => ({ type: 'content', content })
const doneChunk = (promptTokens: number, completionTokens: number) => ({
  type: 'done',
  usage: {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  },
})

const EXTRACTION = JSON.stringify({
  fields: { name: 'M4 x 16 SHCS', partType: 'Purchase' },
  customAttributes: { Material: 'A2 stainless' },
})

/** A 1x1 PNG; the service never decodes it, only bounds and forwards it. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const png: EnrichmentImage = { mediaType: 'image/png', data: PNG_BASE64 }

describe('enrichItem', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(() => {
    testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    chunks = [contentChunk(EXTRACTION), doneChunk(900, 60)]
    chatCalls = []

    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    await testDb.db.insert(aiSettings).values({
      programId: null,
      provider: 'anthropic',
      config: { provider: 'anthropic', model: 'global-model' },
      enabled: true,
    })
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function enrichLink() {
    return enrichItem({
      url: 'https://example.com/m4-shcs',
      itemType: 'Part',
      userId: user.id,
    })
  }

  /** Every usage row this user has. */
  async function usageRows() {
    return await testDb.db
      .select()
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.userId, user.id))
  }

  /** The content parts of the single user message the model was sent. */
  function sentContent(): Array<any> {
    expect(chatCalls).toHaveLength(1)
    return chatCalls[0].messages[0].content
  }

  describe('usage metering', () => {
    it('records one row against the user who dropped the link', async () => {
      const result = await enrichLink()

      expect(result.fields.name).toBe('M4 x 16 SHCS')
      expect(result.link).toBe('https://example.com/m4-shcs')

      const rows = await usageRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: user.id,
        // No program: the item this enriches does not exist yet.
        programId: null,
        // An LLM-call row, not a tool-call row.
        toolName: null,
        provider: 'anthropic',
        model: 'global-model',
        inputTokens: 900,
        outputTokens: 60,
      })
    })

    it('records the tokens a call spent before the stream died', async () => {
      chunks = [doneChunk(900, 0), THROW]

      // The caller sees a graceful degrade, flagged as a failure rather than
      // an empty page — the tokens were still spent, and that is what must
      // not be lost with it.
      const result = await enrichLink()
      expect(result).toMatchObject({
        aiEnabled: true,
        extractionFailed: true,
        fields: {},
      })

      const rows = await usageRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ inputTokens: 900, outputTokens: 0 })
    })

    it('meters a dropped image the same way as a link', async () => {
      const result = await enrichItem({
        itemType: 'Part',
        images: [png],
        userId: user.id,
      })

      expect(result.fields.name).toBe('M4 x 16 SHCS')
      // No link was given, so none is invented.
      expect(result.link).toBeUndefined()

      const rows = await usageRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: user.id,
        programId: null,
        inputTokens: 900,
        outputTokens: 60,
      })
    })

    it('answers a reached monthly budget with its 429 before anything is spent', async () => {
      await testDb.db
        .update(aiSettings)
        .set({
          config: {
            provider: 'anthropic',
            model: 'global-model',
            monthlyTokenBudget: 100,
          },
        })
        .where(isNull(aiSettings.programId))
      // Month-to-date spend already past the budget.
      await recordLlmUsage({
        userId: user.id,
        inputTokens: 150,
        outputTokens: 0,
      })

      await expect(enrichLink()).rejects.toBeInstanceOf(RateLimitedError)

      // No model call, and no row for one — a token-less row would still be
      // a row the budget query has to explain.
      expect(chatCalls).toHaveLength(0)
      expect(await usageRows()).toHaveLength(1)
    })
  })

  describe('image bounds', () => {
    it('rejects an oversize image before the model is called', async () => {
      const oversize: EnrichmentImage = {
        mediaType: 'image/jpeg',
        data: 'A'.repeat(MAX_ENRICHMENT_IMAGE_BASE64_CHARS + 4),
      }

      await expect(
        enrichItem({ itemType: 'Part', images: [oversize], userId: user.id }),
      ).rejects.toBeInstanceOf(ValidationError)

      expect(chatCalls).toHaveLength(0)
      expect(await usageRows()).toHaveLength(0)
    })

    it('rejects an image type the providers do not take', async () => {
      const svg = { mediaType: 'image/svg+xml', data: PNG_BASE64 }

      await expect(
        enrichItem({
          itemType: 'Part',
          images: [svg as unknown as EnrichmentImage],
          userId: user.id,
        }),
      ).rejects.toBeInstanceOf(ValidationError)
      expect(chatCalls).toHaveLength(0)
    })

    it('rejects a data-URI payload rather than forwarding it as base64', async () => {
      const dataUri: EnrichmentImage = {
        mediaType: 'image/png',
        data: `data:image/png;base64,${PNG_BASE64}`,
      }

      await expect(
        enrichItem({ itemType: 'Part', images: [dataUri], userId: user.id }),
      ).rejects.toBeInstanceOf(ValidationError)
      expect(chatCalls).toHaveLength(0)
    })

    it('rejects more images than one request may carry', async () => {
      await expect(
        enrichItem({
          itemType: 'Part',
          images: [png, png, png, png, png],
          userId: user.id,
        }),
      ).rejects.toBeInstanceOf(ValidationError)
      expect(chatCalls).toHaveLength(0)
    })

    it('requires a source', async () => {
      await expect(
        enrichItem({ itemType: 'Part', userId: user.id }),
      ).rejects.toBeInstanceOf(ValidationError)
      expect(chatCalls).toHaveLength(0)
    })
  })

  describe('image parts', () => {
    // The two adapters disagree about what `source.value` holds for inline
    // data. Anthropic's wants raw base64 with the media type alongside; the
    // OpenAI-compatible one forwards the value verbatim as `image_url`, so it
    // must already be a data URI. Sending either the other's shape is a
    // provider 400 on every image drop.
    it('gives Anthropic raw base64 and the media type', async () => {
      await enrichItem({ itemType: 'Part', images: [png], userId: user.id })

      expect(sentContent()).toContainEqual({
        type: 'image',
        source: { type: 'data', value: PNG_BASE64 },
        metadata: { mediaType: 'image/png' },
      })
    })

    it('gives an OpenAI-compatible provider a data URI', async () => {
      await testDb.db
        .update(aiSettings)
        .set({
          provider: 'openai',
          config: { provider: 'openai', model: 'global-model' },
        })
        .where(isNull(aiSettings.programId))

      await enrichItem({ itemType: 'Part', images: [png], userId: user.id })

      expect(sentContent()).toContainEqual({
        type: 'image',
        source: { type: 'url', value: `data:image/png;base64,${PNG_BASE64}` },
      })
    })
  })

  describe('tool suggestions', () => {
    function enrichTool() {
      return enrichItem({
        url: 'https://example.com/mill',
        itemType: 'Tool',
        userId: user.id,
      })
    }

    it('files a tool under the group its subtype belongs to, and keeps only capabilities its schema accepts', async () => {
      chunks = [
        contentChunk(
          JSON.stringify({
            fields: {
              name: 'VF-2',
              toolSubtype: 'cnc_mill',
              // Wrong group for a mill; the catalog decides, not the model.
              toolType: 'quality',
            },
            capabilities: {
              axes: 3,
              spindleSpeedRange: [100, 10000],
              toolChangerSlots: 20,
              // Not the [x, y, z] tuple the schema asks for.
              workVolume: '762 x 406 x 508',
              // Not a key the schema has.
              coolant: 'flood',
            },
            customAttributes: { Weight: '3,500 kg' },
          }),
        ),
        doneChunk(500, 80),
      ]

      const result = await enrichTool()

      expect(result.fields).toMatchObject({
        toolSubtype: 'cnc_mill',
        toolType: 'manufacturing',
      })
      expect(result.capabilities).toEqual({
        axes: 3,
        spindleSpeedRange: [100, 10000],
        toolChangerSlots: 20,
      })
      expect(result.attributes).toEqual({ Weight: '3,500 kg' })
    })

    it('drops a subtype outside the catalog rather than suggesting one the form cannot show', async () => {
      chunks = [
        contentChunk(
          JSON.stringify({
            fields: { name: 'Scanner', toolSubtype: 'quantum_forge' },
            capabilities: { resolution: 0.1 },
            customAttributes: {},
          }),
        ),
        doneChunk(500, 80),
      ]

      const result = await enrichTool()

      expect(result.fields.toolSubtype).toBeUndefined()
      expect(result.fields.name).toBe('Scanner')
      expect(result.capabilities).toBeUndefined()
    })
  })
})
