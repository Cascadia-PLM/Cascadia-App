// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assembly composition stage — usage metering
 *
 * Data-integrity gate, and the data is money: `ai_usage_logs` is what
 * `enforceMonthlyTokenBudget` sums, so a stage that spends tokens without
 * writing a row is not merely missing telemetry — it is spend that escapes
 * the budget, and a program with a ceiling never reaches it.
 *
 * The invariants held here: one row per *run* however many assemblies it
 * plans, carrying the session's program so the program-scoped budget sees it;
 * the row survives a stream that dies mid-plan; and a run that never asks the
 * model anything writes no row at all.
 *
 * The rows are asserted in the database rather than on a `recordLlmUsage` spy
 * on purpose — that function swallows its own insert failures, so a spy can
 * pass while nothing lands.
 *
 * Run: npx vitest run cascadia-design-engine/src/design-engine/stages/assembly-composition.test.ts
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
import { eq } from 'drizzle-orm'
import { DesignSessionService } from '../session-service'
import type * as TanStackAi from '@tanstack/ai'
import type * as Adapters from '@/ai/adapters'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { BomNodeDraft, DesignArtifacts, StageEvent } from '../types'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { aiUsageLogs, programs } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

/** Scripted chunk that makes the stream throw where a real provider would. */
const THROW = Symbol('stream throws here')

/** One entry per chat() call the planner made. */
const chatCalls: Array<{ maxTokens: number }> = []
/** Chunk script per chat() call, by index; the last entry repeats. */
let chunkScript: Array<Array<unknown>> = []

vi.mock('@tanstack/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackAi>()),
  chat: (opts: { maxTokens: number }) => {
    const index = chatCalls.length
    chatCalls.push({ maxTokens: opts.maxTokens })
    return (async function* () {
      await Promise.resolve()
      const chunks = chunkScript[index] ?? chunkScript[chunkScript.length - 1]
      for (const chunk of chunks ?? []) {
        if (chunk === THROW) throw new Error('provider stream terminated')
        yield chunk
      }
    })()
  },
}))

/** Program ids the planner resolved its provider config against, in order. */
const resolvedFor: Array<string | undefined> = []

vi.mock('@/ai/adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  loadProviderConfig: (programId?: string) => {
    resolvedFor.push(programId)
    return Promise.resolve({
      provider: 'anthropic' as const,
      apiKey: 'test-key',
      model: 'claude-opus-5',
    })
  },
  getAdapter: () => ({}),
}))

// Imported after the mocks so the factories above are the ones that bind.
const { runAssemblyCompositionStage } = await import('./assembly-composition')

const contentChunk = (content: string) => ({
  type: 'TEXT_MESSAGE_CONTENT',
  messageId: 'message-1',
  delta: content,
})
const doneChunk = (promptTokens: number, completionTokens: number) => ({
  type: 'RUN_FINISHED',
  usage: {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  },
})

/** A plan the real parser and validator both accept. */
function planFor(tempId: string): string {
  return JSON.stringify({
    reasoning: 'stack them',
    placements: [
      {
        tempId,
        partName: `Part ${tempId}`,
        stepFileKey: `vault-${tempId}`,
        transform: {
          translation: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
        },
        quantity: 1,
      },
    ],
  })
}

/** A generated leaf part: has geometry, so its parent is composable. */
function leaf(tempId: string): BomNodeDraft {
  return {
    tempId,
    name: `Part ${tempId}`,
    isNew: true,
    quantity: 1,
    children: [],
    requirementTempIds: [],
    partType: 'Manufacture',
    rationale: 'structure',
    confidence: 1,
    cadGeneration: {
      status: 'complete',
      generationMethod: 'freecad',
      stepFileKey: `vault-${tempId}`,
    },
  }
}

/** A bought-in leaf: no geometry, so its parent is skipped un-planned. */
function purchasedLeaf(tempId: string): BomNodeDraft {
  return {
    tempId,
    name: `Part ${tempId}`,
    isNew: true,
    quantity: 1,
    children: [],
    requirementTempIds: [],
    partType: 'Purchase',
    rationale: 'off the shelf',
    confidence: 1,
  }
}

function assembly(tempId: string, children: Array<BomNodeDraft>): BomNodeDraft {
  return {
    tempId,
    name: `Assembly ${tempId}`,
    isNew: true,
    quantity: 1,
    children,
    requirementTempIds: [],
    partType: 'Phantom',
    rationale: 'assembly',
    confidence: 1,
  }
}

function artifactsFor(root: BomNodeDraft): DesignArtifacts {
  return {
    description: 'A two-sub-assembly rig',
    requirements: [],
    bom: {
      rootAssembly: root,
      proposedParts: [],
      requirementsCoverage: {},
      uncoveredRequirements: [],
      validationIssues: [],
    },
    clarifications: [],
    userMessages: [],
    // No ecoId, so no branch resolves and every composed node lands on the
    // script-only path — the renderer is never reached and never needs mocking.
    materializationResult: {
      designId: 'design-1',
      createdItems: [],
      bomRelationshipsCreated: 0,
    },
  }
}

describe('runAssemblyCompositionStage usage metering', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let sessionId: string

  beforeAll(() => {
    testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    chatCalls.length = 0
    resolvedFor.length = 0
    chunkScript = []

    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Assembly P',
          code: `ASMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id
    const created = await DesignSessionService.create(user.id, {
      description: 'A two-sub-assembly rig',
      programId,
    })
    sessionId = created.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** Seed the session with this BOM and run the stage to exhaustion. */
  async function runStage(root: BomNodeDraft) {
    await DesignSessionService.updateArtifacts(sessionId, artifactsFor(root))
    await DesignSessionService.updateStage(sessionId, 'assembly_composition')
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error('session vanished')

    const events: Array<StageEvent> = []
    for await (const event of runAssemblyCompositionStage(session)) {
      events.push(event)
    }
    return events
  }

  /** Every usage row this run wrote. */
  async function usageRows() {
    return await testDb.db
      .select()
      .from(aiUsageLogs)
      .where(eq(aiUsageLogs.userId, user.id))
  }

  it('writes one row for the whole run, however many assemblies it planned', async () => {
    chunkScript = [
      [contentChunk(planFor('a1')), doneChunk(10, 5)],
      [contentChunk(planFor('b1')), doneChunk(7, 3)],
    ]

    await runStage(
      assembly('root', [
        assembly('asm-a', [leaf('a1'), leaf('a2')]),
        assembly('asm-b', [leaf('b1'), leaf('b2')]),
      ]),
    )

    // Two planner calls...
    expect(chatCalls).toHaveLength(2)
    // ...and both resolved provider config against the session's program, so
    // the program's budget is what gated them.
    expect(resolvedFor).toEqual([programId, programId])

    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: user.id,
      programId,
      // An LLM-call row, not a tool-call row.
      toolName: null,
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 17,
      outputTokens: 8,
    })
  })

  it('records the tokens a run spent before the stream died', async () => {
    chunkScript = [[doneChunk(12, 4), THROW]]

    await runStage(assembly('root', [leaf('a1'), leaf('a2')]))

    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 12, outputTokens: 4 })
  })

  it('writes no row for a run that never reached the planner', async () => {
    // Nothing to compose: no child carries geometry, so the stage skips the
    // assembly without asking the model anything. A row here would claim a
    // call that never happened.
    await runStage(assembly('root', [purchasedLeaf('p1'), purchasedLeaf('p2')]))

    expect(chatCalls).toHaveLength(0)
    expect(await usageRows()).toHaveLength(0)
  })
})
