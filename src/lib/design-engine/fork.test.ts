// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Session fork tests — data-integrity gate.
 *
 * A fork must never share PLM linkage with its source:
 * materializationResult maps tempIds to real item IDs, so a fork keeping it
 * would upload regenerated CAD onto the ORIGINAL session's parts. Invariants:
 * materialization state is stripped and the stage capped at bom_review;
 * pending clarifications are cleared; snapshots copy over; the source row
 * is untouched.
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
import { DesignSessionService } from './session-service'
import { DesignSnapshotService } from './snapshot-service'
import type { DesignArtifacts } from './types'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { programs } from '@/lib/db/schema'

function buildArtifacts(overrides?: Partial<DesignArtifacts>): DesignArtifacts {
  return {
    description: 'A robot gripper',
    requirements: [
      {
        tempId: 'req-1',
        name: 'Grips 2kg payloads',
        description: 'Holds parts up to 2kg',
        requirementType: 'Functional',
        priority: 'high',
        verificationMethod: 'Test',
        rationale: 'Core function',
        confidence: 0.9,
        source: 'ai',
        reviewStatus: 'accepted',
      },
    ],
    bom: {
      rootAssembly: {
        tempId: 'root',
        name: 'Gripper Assembly',
        isNew: true,
        quantity: 1,
        children: [
          {
            tempId: 'jaw',
            name: 'Jaw Plate',
            isNew: true,
            quantity: 2,
            partType: 'Manufacture',
            children: [],
            requirementTempIds: ['req-1'],
            rationale: '',
            confidence: 0.9,
            cadGeneration: { status: 'complete', stepFileKey: 'file-1' },
            assemblyComposition: { status: 'code_only' },
          },
        ],
        requirementTempIds: [],
        rationale: '',
        confidence: 0.9,
      },
      proposedParts: [],
      requirementsCoverage: { 'req-1': ['jaw'] },
      uncoveredRequirements: [],
      validationIssues: [],
    },
    clarifications: [],
    userMessages: [],
    ...overrides,
  }
}

describe('DesignSessionService.fork', () => {
  const testDb = new TestDatabase()
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
        name: 'Fork Test Program',
        code: `PROG-FORK-${Date.now()}`,
        createdBy: user.id,
      })
      .returning()
    programId = program!.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createSession(artifacts: DesignArtifacts) {
    const session = await DesignSessionService.create(user.id, {
      description: 'A robot gripper',
      programId,
    })
    await DesignSessionService.updateArtifacts(session.id, artifacts)
    return session
  }

  it('a fork of a materialized session shares no PLM linkage and re-enters at bom_review', async () => {
    const session = await createSession(
      buildArtifacts({
        materializationResult: {
          designId: crypto.randomUUID(),
          createdItems: [
            {
              tempId: 'jaw',
              itemId: crypto.randomUUID(),
              itemNumber: 'P-0001',
              itemType: 'Part',
              name: 'Jaw Plate',
            },
          ],
          bomRelationshipsCreated: 1,
        },
        cadGenerationState: {
          status: 'complete',
          partsTotal: 1,
          partsCompleted: 1,
          partsFailed: 0,
          assembliesTotal: 1,
          assembliesCompleted: 1,
          assembliesFailed: 0,
        },
      }),
    )
    await DesignSessionService.updateStage(session.id, 'cad_review')

    const fork = await DesignSessionService.fork(session.id, user.id)

    expect(fork.id).not.toBe(session.id)
    expect(fork.forkedFromSessionId).toBe(session.id)
    expect(fork.stage).toBe('bom_review')
    expect(fork.status).toBe('active')
    expect(fork.materializedDesignId).toBeNull()
    expect(fork.artifacts!.materializationResult).toBeUndefined()
    expect(fork.artifacts!.cadGenerationState).toBeUndefined()
    const jaw = fork.artifacts!.bom!.rootAssembly.children[0]!
    expect(jaw.cadGeneration).toBeUndefined()
    expect(jaw.assemblyComposition).toBeUndefined()

    // Source is untouched
    const source = await DesignSessionService.getById(session.id)
    expect(source!.artifacts!.materializationResult).toBeDefined()
    expect(
      source!.artifacts!.bom!.rootAssembly.children[0]!.cadGeneration?.status,
    ).toBe('complete')
  })

  it('a pre-materialization fork keeps stage and artifacts but clears pending clarification', async () => {
    const session = await createSession(
      buildArtifacts({
        pendingClarificationId: 'q1',
        pendingClarification: { id: 'q1', question: 'Which material?' },
      }),
    )
    await DesignSessionService.updateStage(session.id, 'bom_drafting')

    const fork = await DesignSessionService.fork(session.id, user.id, {
      title: 'Aluminum variant',
    })

    expect(fork.stage).toBe('bom_drafting')
    expect(fork.title).toBe('Aluminum variant')
    expect(fork.artifacts!.pendingClarification).toBeUndefined()
    expect(fork.artifacts!.pendingClarificationId).toBeUndefined()
    expect(fork.artifacts!.requirements).toHaveLength(1)
    // Generation status untouched pre-materialization (no PLM linkage in it
    // to leak — stepFileKey references vault files, not parts)
    expect(fork.pendingGuidance).toEqual([])
  })

  it('copies snapshots so diff bases and rollback survive in the fork', async () => {
    const session = await createSession(buildArtifacts())
    await DesignSnapshotService.create(
      session.id,
      'requirements_review',
      buildArtifacts(),
      3,
    )

    const fork = await DesignSessionService.fork(session.id, user.id)

    const copied = await DesignSnapshotService.getLatestForStage(
      fork.id,
      'requirements_review',
    )
    expect(copied).not.toBeNull()
    expect(copied!.llmHistoryLength).toBe(3)
    // Source snapshot still present
    expect(
      await DesignSnapshotService.getLatestForStage(
        session.id,
        'requirements_review',
      ),
    ).not.toBeNull()
  })

  it('includeLlmHistory: false starts the fork with an empty conversation', async () => {
    const session = await createSession(buildArtifacts())
    await DesignSessionService.saveLlmHistory(session.id, [
      { role: 'assistant', content: 'prior reasoning' },
    ])

    const withHistory = await DesignSessionService.fork(session.id, user.id)
    expect(withHistory.llmHistory).toHaveLength(1)

    const withoutHistory = await DesignSessionService.fork(session.id, user.id, {
      includeLlmHistory: false,
    })
    expect(withoutHistory.llmHistory).toEqual([])
  })
})
