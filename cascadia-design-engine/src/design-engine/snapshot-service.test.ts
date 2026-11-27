// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * DesignSnapshotService + reopenStage Tests
 *
 * Data-integrity tests for the snapshot/rollback foundation. Invariants:
 * - Confirming a review gate persists a snapshot that deep-equals the
 *   session's artifacts at that moment.
 * - Reopening a stage restores exactly the snapshotted artifacts and
 *   truncates llmHistory to what the AI knew at confirm time.
 * - Reopening is refused once the session has materialized PLM items,
 *   and refused when the target stage is not strictly earlier.
 * - History capture bounds each entry's PAYLOAD and never its COUNT: the
 *   snapshot's llmHistoryLength is a position in that array, so an entry that
 *   vanished would move every gate's restore point.
 *
 * Run: npx vitest run src/design-engine/snapshot-service.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { CollaborativeDesignEngine } from './engine'
import { DesignSessionService } from './session-service'
import { DesignSnapshotService } from './snapshot-service'
import { summarizeToolCalls } from './prompts/tool-call-summary'
import type { DesignSession } from './session-service'
import type { DesignArtifacts, LlmHistoryEntry, StageEvent } from './types'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { programs } from '@/db/schema'
import { ValidationError } from '@/errors'

function buildArtifacts(overrides?: Partial<DesignArtifacts>): DesignArtifacts {
  return {
    description: 'A bracket assembly',
    requirements: [
      {
        tempId: 'req-1',
        name: 'Holds 1kg load',
        description: 'The assembly must support a 1kg load',
        requirementType: 'Functional',
        priority: 'high',
        verificationMethod: 'Test',
        rationale: 'Primary use case',
        confidence: 0.9,
        source: 'ai',
        reviewStatus: 'accepted',
      },
    ],
    bom: null,
    clarifications: [],
    userMessages: [],
    ...overrides,
  }
}

describe('DesignSnapshotService + reopenStage', () => {
  const testDb = new TestDatabase()
  const engine = new CollaborativeDesignEngine()
  let user: TestUser
  let programId: string

  beforeAll(() => {
    testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    user = await insertTestUser(testDb.db)
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Snapshot Test Program',
        code: `PROG-SNAP-${Date.now()}`,
        createdBy: user.id,
      })
      .returning()
    programId = program!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createSession(
    artifacts: DesignArtifacts,
  ): Promise<DesignSession> {
    const session = await DesignSessionService.create(user.id, {
      description: 'A bracket assembly',
      programId,
    })
    await DesignSessionService.updateArtifacts(session.id, artifacts)
    return (await DesignSessionService.getById(session.id))!
  }

  /**
   * Drive the private history-capture wrapper over a synthetic event stream
   * and return what it persisted. It is the only writer of llmHistory, and
   * llmHistory positions are what snapshots index; reaching it through a
   * public stage generator would need a live LLM.
   */
  type HistoryCapture = (
    sessionId: string,
    generator: AsyncIterable<StageEvent>,
  ) => AsyncIterable<StageEvent>

  async function captureHistory(
    sessionId: string,
    events: Array<StageEvent>,
  ): Promise<Array<LlmHistoryEntry>> {
    async function* source(): AsyncIterable<StageEvent> {
      for (const event of events) {
        // Stage generators are asynchronous between events; keep the shape.
        await Promise.resolve()
        yield event
      }
    }
    const wrap = (
      engine as unknown as { wrapWithHistoryCapture: HistoryCapture }
    ).wrapWithHistoryCapture.bind(engine)

    const yielded: Array<StageEvent> = []
    for await (const event of wrap(sessionId, source())) yielded.push(event)
    // Capture is a pass-through: every event still reaches the SSE route.
    expect(yielded).toHaveLength(events.length)

    const session = await DesignSessionService.getById(sessionId)
    return session!.llmHistory ?? []
  }

  /** Mirrors TOOL_RESULT_ENTRY_CAP in engine.ts. */
  const TOOL_RESULT_ENTRY_CAP = 8_192

  function searchEvents(rowCount: number): Array<StageEvent> {
    return [
      { type: 'llm_text', text: 'Looking for a bracket' },
      {
        type: 'tool_call',
        toolName: 'search_parts',
        args: { query: 'bracket' },
      },
      {
        type: 'tool_result',
        toolName: 'search_parts',
        result: {
          total: 42,
          parts: Array.from({ length: rowCount }, (_, i) => ({
            id: `part-${i}`,
            name: `Bracket "variant" ${i}`,
            description: 'x'.repeat(200),
          })),
        },
      },
      { type: 'llm_text', text: 'Those look usable' },
    ]
  }

  it('confirmStage persists a snapshot that deep-equals the session artifacts', async () => {
    const artifacts = buildArtifacts()
    const session = await createSession(artifacts)
    await DesignSessionService.updateStage(session.id, 'requirements_review')
    await DesignSessionService.saveLlmHistory(session.id, [
      { role: 'assistant', content: 'proposed requirements' },
    ])

    await engine.confirmStage(session.id, 'requirements')

    const snapshot = await DesignSnapshotService.getLatestForStage(
      session.id,
      'requirements_review',
    )
    expect(snapshot).not.toBeNull()
    expect(snapshot!.artifacts).toEqual(artifacts)
    expect(snapshot!.llmHistoryLength).toBe(1)
    expect(snapshot!.seq).toBe(1)

    const updated = await DesignSessionService.getById(session.id)
    expect(updated!.stage).toBe('bom_drafting')
  })

  it('snapshots are append-only with monotonic seq across gates', async () => {
    const session = await createSession(buildArtifacts())

    await DesignSessionService.updateStage(session.id, 'toolset_review')
    await engine.confirmStage(session.id, 'toolset')
    await DesignSessionService.updateStage(session.id, 'requirements_review')
    await engine.confirmStage(session.id, 'requirements')

    const all = await DesignSnapshotService.listBySession(session.id)
    expect(all.map((s) => s.seq)).toEqual([2, 1])
    expect(all.map((s) => s.stage)).toEqual([
      'requirements_review',
      'toolset_review',
    ])
  })

  it('reopenStage restores the snapshotted artifacts and truncates llmHistory', async () => {
    const approved = buildArtifacts()
    const session = await createSession(approved)
    await DesignSessionService.updateStage(session.id, 'requirements_review')
    await DesignSessionService.saveLlmHistory(session.id, [
      { role: 'assistant', content: 'requirements pass' },
    ])
    await engine.confirmStage(session.id, 'requirements')

    // Simulate the BOM pass mutating artifacts and growing history
    const mutated = buildArtifacts({
      description: 'Changed during BOM drafting',
      userMessages: [
        {
          id: 'm1',
          text: 'make it lighter',
          createdAt: new Date().toISOString(),
          stage: 'bom_drafting',
        },
      ],
      pendingClarificationId: 'q1',
      pendingClarification: { id: 'q1', question: 'Which material?' },
    })
    await DesignSessionService.updateArtifacts(session.id, mutated)
    await DesignSessionService.saveLlmHistory(session.id, [
      { role: 'assistant', content: 'requirements pass' },
      { role: 'assistant', content: 'bom pass' },
      { role: 'tool', content: '{"toolName":"propose_new_part"}' },
    ])
    await DesignSessionService.updateStage(session.id, 'bom_drafting')

    await engine.reopenStage(session.id, 'requirements_review')

    const reopened = await DesignSessionService.getById(session.id)
    expect(reopened!.stage).toBe('requirements_review')
    expect(reopened!.artifacts).toEqual({
      ...approved,
      pendingClarificationId: undefined,
      pendingClarification: undefined,
    })
    expect(reopened!.llmHistory).toEqual([
      { role: 'assistant', content: 'requirements pass' },
    ])
  })

  it('reopenStage throws once the session has materialized', async () => {
    const session = await createSession(
      buildArtifacts({
        materializationResult: {
          designId: crypto.randomUUID(),
          createdItems: [],
          bomRelationshipsCreated: 0,
        },
      }),
    )
    await DesignSessionService.updateStage(session.id, 'cad_generation')

    await expect(
      engine.reopenStage(session.id, 'requirements_review'),
    ).rejects.toThrow(ValidationError)
  })

  it('reopenStage throws when the target is not strictly earlier', async () => {
    const session = await createSession(buildArtifacts())
    await DesignSessionService.updateStage(session.id, 'requirements_review')

    await expect(
      engine.reopenStage(session.id, 'requirements_review'),
    ).rejects.toThrow(ValidationError)
    await expect(engine.reopenStage(session.id, 'bom_review')).rejects.toThrow(
      ValidationError,
    )
  })

  it('reopenStage without a snapshot (legacy session) clears downstream artifacts', async () => {
    const artifacts = buildArtifacts({
      bom: {
        rootAssembly: {
          tempId: 'root',
          name: 'Root',
          isNew: true,
          quantity: 1,
          children: [],
          requirementTempIds: [],
          rationale: '',
          confidence: 1,
        },
        proposedParts: [],
        requirementsCoverage: {},
        uncoveredRequirements: [],
        validationIssues: [],
      },
    })
    const session = await createSession(artifacts)
    await DesignSessionService.updateStage(session.id, 'bom_drafting')

    await engine.reopenStage(session.id, 'requirements_review')

    const reopened = await DesignSessionService.getById(session.id)
    expect(reopened!.stage).toBe('requirements_review')
    expect(reopened!.artifacts!.bom).toBeNull()
    // Requirements survive a legacy reopen to requirements_review
    expect(reopened!.artifacts!.requirements).toHaveLength(1)
  })

  it('confirmStage blocks while AI proposals are unreviewed, unless forced', async () => {
    const artifacts = buildArtifacts()
    artifacts.requirements.push({
      tempId: 'req-2',
      name: 'Weighs under 500g',
      description: 'Total mass below 500g',
      requirementType: 'Performance',
      priority: 'medium',
      verificationMethod: 'Test',
      rationale: 'Portability',
      confidence: 0.8,
      source: 'ai',
      // no reviewStatus — effective 'proposed'
    })
    const session = await createSession(artifacts)
    await DesignSessionService.updateStage(session.id, 'requirements_review')

    await expect(
      engine.confirmStage(session.id, 'requirements'),
    ).rejects.toThrow(ValidationError)
    // Blocked confirm leaves no snapshot and no stage change
    expect(
      await DesignSnapshotService.getLatestForStage(
        session.id,
        'requirements_review',
      ),
    ).toBeNull()
    expect((await DesignSessionService.getById(session.id))!.stage).toBe(
      'requirements_review',
    )

    await engine.confirmStage(session.id, 'requirements', { force: true })
    expect((await DesignSessionService.getById(session.id))!.stage).toBe(
      'bom_drafting',
    )
  })

  it('confirmStage counts nested unreviewed BOM nodes but skips the root', async () => {
    const session = await createSession(
      buildArtifacts({
        bom: {
          rootAssembly: {
            tempId: 'root',
            name: 'Root Assembly',
            isNew: true,
            quantity: 1,
            children: [
              {
                tempId: 'sub',
                name: 'Sub Assembly',
                isNew: true,
                quantity: 1,
                partType: 'Phantom',
                reviewStatus: 'accepted',
                children: [
                  {
                    tempId: 'leaf',
                    name: 'Deep Leaf Part',
                    isNew: true,
                    quantity: 2,
                    partType: 'Manufacture',
                    // no reviewStatus — effective 'proposed'
                    children: [],
                    requirementTempIds: [],
                    rationale: '',
                    confidence: 0.8,
                  },
                ],
                requirementTempIds: [],
                rationale: '',
                confidence: 0.8,
              },
            ],
            requirementTempIds: [],
            rationale: '',
            confidence: 0.9,
            // root has no reviewStatus either — must be skipped
          },
          proposedParts: [],
          requirementsCoverage: {},
          uncoveredRequirements: [],
          validationIssues: [],
        },
      }),
    )
    await DesignSessionService.updateStage(session.id, 'bom_review')

    await expect(engine.confirmStage(session.id, 'bom')).rejects.toThrow(
      /1 BOM item is still unreviewed/,
    )

    await engine.confirmStage(session.id, 'bom', { force: true })
    expect((await DesignSessionService.getById(session.id))!.stage).toBe(
      'materialization',
    )
  })

  it('copyToSession duplicates all snapshots onto the target session', async () => {
    const session = await createSession(buildArtifacts())
    await DesignSessionService.updateStage(session.id, 'requirements_review')
    await engine.confirmStage(session.id, 'requirements')

    const other = await DesignSessionService.create(user.id, {
      description: 'fork target',
      programId,
    })
    const copied = await DesignSnapshotService.copyToSession(
      session.id,
      other.id,
    )
    expect(copied).toBe(1)

    const source = await DesignSnapshotService.getLatestForStage(
      session.id,
      'requirements_review',
    )
    const target = await DesignSnapshotService.getLatestForStage(
      other.id,
      'requirements_review',
    )
    expect(target).not.toBeNull()
    expect(target!.artifacts).toEqual(source!.artifacts)
    expect(target!.seq).toBe(source!.seq)
  })

  it('history capture bounds the payload and never the entry count', async () => {
    const session = await createSession(buildArtifacts())

    // assistant text, the call, the result, the trailing assistant text
    const small = await captureHistory(session.id, searchEvents(1))
    expect(small).toHaveLength(4)

    // The same event stream with a payload three orders of magnitude bigger
    // must produce the same number of entries — only shorter ones.
    await DesignSessionService.saveLlmHistory(session.id, [])
    const huge = await captureHistory(session.id, searchEvents(500))
    expect(huge).toHaveLength(small.length)

    // The snapshot's restore point is a POSITION in that array, so a gate
    // confirmed after either run rolls back to the same entry.
    await DesignSessionService.updateStage(session.id, 'requirements_review')
    await engine.confirmStage(session.id, 'requirements')
    const snapshot = await DesignSnapshotService.getLatestForStage(
      session.id,
      'requirements_review',
    )
    expect(snapshot!.llmHistoryLength).toBe(small.length)
  })

  it('an oversized tool_result is stored truncated and still parses', async () => {
    const session = await createSession(buildArtifacts())
    const history = await captureHistory(session.id, searchEvents(500))

    const resultEntry = history[2]
    expect(resultEntry).toBeDefined()
    expect(resultEntry!.content.length).toBeLessThanOrEqual(
      TOOL_RESULT_ENTRY_CAP,
    )

    // Slicing the envelope would leave an entry neither reader can parse, and
    // both drop what they cannot parse — which would delete the entry from
    // the resume summary and the activity feed.
    const parsed = JSON.parse(resultEntry!.content) as {
      toolName: string
      result: { total: number; truncated: boolean }
    }
    expect(parsed.toolName).toBe('search_parts')
    expect(parsed.result.truncated).toBe(true)
    // Top-level scalars survive, which is what the resume summary reads.
    expect(parsed.result.total).toBe(42)

    const summary = summarizeToolCalls(history)
    expect(summary).toContain('search_parts')
    expect(summary).toContain('42 results')
  })
})
