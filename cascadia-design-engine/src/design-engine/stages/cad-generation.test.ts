// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CAD generation stage — per-part persistence invariants
 *
 * Data-integrity gate, and the cost is real: a FreeCAD agent run is several
 * model turns and FreeCAD executions, minutes per part. The stage used to
 * write the session exactly once, after the whole run, so an abort, a crash
 * or a stream-claim displacement threw away every finished part's status
 * while its STEP file stayed in the vault — and the resume filter, which
 * skips parts whose `cadGeneration.status` is 'complete', therefore re-ran
 * all of them.
 *
 * The invariant these tests hold: a part that finished is durable the moment
 * it finishes, and a later run does not generate it again.
 *
 * No model and no worker are contacted — the FreeCAD agent is mocked at the
 * module level for the whole file.
 *
 * Run: npx vitest run cascadia-design-engine/src/design-engine/stages/cad-generation.test.ts
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
import { DesignSessionService } from '../session-service'
import type { TestUser } from '@/__tests__/fixtures/users'
import type * as PartGenerator from '@/cad-generation/part-generator'
import type {
  BomDraft,
  BomNodeDraft,
  DesignArtifacts,
  StageEvent,
} from '../types'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { programs } from '@/db/schema'
import { takeFirst } from '@/db/take-first'

/** Parts the (mocked) FreeCAD agent was asked to generate, in order. */
const agentRuns: Array<{ partName: string; itemId: string }> = []
/** tempIds the fake generator generated, one array per run of the stage. */
const generatedRuns: Array<Array<string>> = []
/** Statuses the fake generator was handed, one snapshot per run. */
const receivedStatuses: Array<Record<string, string | undefined>> = []
/** tempIds the fake generator should report as failures. */
const failTempIds = new Set<string>()
/** The unmocked `generateAllParts`, captured from the partial mock below. */
let realGenerateAllParts: typeof PartGenerator.generateAllParts

vi.mock('@/cad-generation/freecad-agent', () => ({
  generatePartWithFreecad: (options: { partName: string; itemId: string }) => {
    agentRuns.push({ partName: options.partName, itemId: options.itemId })
    return Promise.resolve({
      success: true,
      vaultFileId: `vault-${options.itemId}`,
      fileName: `${options.partName}.step`,
      script: 'import Part\nresult = Part.makeBox(10, 10, 5)\n',
      iterations: 1,
    })
  },
}))

vi.mock('@/cad-generation/part-generator', async (importOriginal) => {
  const actual = await importOriginal<typeof PartGenerator>()
  realGenerateAllParts = actual.generateAllParts
  return {
    ...actual,
    /**
     * Stands in for the FreeCAD/CadQuery round trip only. Which parts it
     * works on still comes from the real `collectCadParts` and the real
     * already-complete filter, so a resume that re-generated a finished part
     * would show up as an extra entry in `generatedRuns`.
     */
    generateAllParts: async function* (
      rootNode: BomNodeDraft,
    ): AsyncGenerator<StageEvent> {
      const { parts } = actual.collectCadParts(rootNode)
      receivedStatuses.push(
        Object.fromEntries(
          parts.map((p) => [p.tempId, p.cadGeneration?.status]),
        ),
      )
      const generated: Array<string> = []
      generatedRuns.push(generated)

      let completed = parts.filter(
        (p) => p.cadGeneration?.status === 'complete',
      ).length
      let failed = 0

      for (const part of parts) {
        if (part.cadGeneration?.status === 'complete') continue
        const success = !failTempIds.has(part.tempId)
        // What the real generator does once the STEP file is in the vault.
        part.cadGeneration = success
          ? {
              status: 'complete',
              generationMethod: 'freecad',
              stepFileKey: `vault-${part.tempId}`,
            }
          : {
              status: 'failed',
              generationMethod: 'freecad',
              errorMessage: 'nope',
            }
        generated.push(part.tempId)
        if (success) completed++
        else failed++

        // Results arrive off the microtask queue, as they would from a real
        // generation.
        await Promise.resolve()
        yield {
          type: 'artifact_update',
          artifacts: {
            cadGenerationState: {
              status: 'generating_parts',
              partsTotal: parts.length,
              partsCompleted: completed,
              partsFailed: failed,
              assembliesTotal: 0,
              assembliesCompleted: 0,
              assembliesFailed: 0,
              startedAt: new Date(0).toISOString(),
            },
          },
        }
      }
    },
  }
})

// Imported after the mocks so the factories above are the ones that bind.
const { runCadGenerationStage } = await import('./cad-generation')

function leaf(tempId: string): BomNodeDraft {
  return {
    tempId,
    name: `Part ${tempId}`,
    isNew: true,
    quantity: 1,
    children: [],
    requirementTempIds: [],
    partType: 'Manufacture',
    // A geometry signal, so the stage's ambiguity pre-flight does not pause
    // the run before any generation happens.
    material: 'Aluminum 6061',
    rationale: 'structure',
    confidence: 1,
  }
}

function bomWith(...leaves: Array<BomNodeDraft>): BomDraft {
  return {
    rootAssembly: {
      tempId: 'root',
      name: 'Root',
      isNew: true,
      quantity: 1,
      children: leaves,
      requirementTempIds: [],
      partType: 'Phantom',
      rationale: 'assembly',
      confidence: 1,
    },
    proposedParts: [],
    requirementsCoverage: {},
    uncoveredRequirements: [],
    validationIssues: [],
  }
}

function artifactsFor(bom: BomDraft): DesignArtifacts {
  return {
    description: 'A two-part bracket',
    requirements: [],
    bom,
    clarifications: [],
    userMessages: [],
    materializationResult: {
      designId: 'design-1',
      createdItems: bom.rootAssembly.children.map((child) => ({
        tempId: child.tempId,
        itemId: `item-${child.tempId}`,
        itemNumber: child.tempId.toUpperCase(),
        itemType: 'Part',
        name: child.name,
      })),
      bomRelationshipsCreated: 0,
    },
  }
}

describe('runCadGenerationStage persistence', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let sessionId: string

  beforeAll(() => {
    testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    agentRuns.length = 0
    generatedRuns.length = 0
    receivedStatuses.length = 0
    failTempIds.clear()

    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'CAD P',
          code: `CADP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const created = await DesignSessionService.create(user.id, {
      description: 'A two-part bracket',
      programId: program.id,
    })
    sessionId = created.id
    await DesignSessionService.updateArtifacts(
      sessionId,
      artifactsFor(bomWith(leaf('p1'), leaf('p2'))),
    )
    await DesignSessionService.updateStage(sessionId, 'cad_generation')
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** Read the session back the way a fresh request would. */
  async function reload() {
    const row = await DesignSessionService.getById(sessionId)
    if (!row) throw new Error('session vanished')
    return row
  }

  function statusOf(artifacts: DesignArtifacts | null, tempId: string) {
    return artifacts?.bom?.rootAssembly.children.find(
      (c) => c.tempId === tempId,
    )?.cadGeneration
  }

  /** Run the stage, abandoning it after `stopAfter` events. */
  async function runStage(stopAfter = Number.POSITIVE_INFINITY) {
    const events: Array<StageEvent> = []
    for await (const event of runCadGenerationStage(await reload())) {
      events.push(event)
      if (events.length >= stopAfter) break
    }
    return events
  }

  it('has part 1 durable before part 2 is even started', async () => {
    await runStage(1)

    // The generator was abandoned after its first result.
    expect(generatedRuns).toEqual([['p1']])

    const artifacts = (await reload()).artifacts
    expect(statusOf(artifacts, 'p1')).toMatchObject({
      status: 'complete',
      stepFileKey: 'vault-p1',
    })
    expect(statusOf(artifacts, 'p2')).toBeUndefined()
    expect(artifacts?.cadGenerationState?.partsCompleted).toBe(1)
  })

  it('does not re-generate a part the interrupted run already finished', async () => {
    await runStage(1)
    await runStage()

    // The second run was handed the persisted status...
    expect(receivedStatuses[1]?.p1).toBe('complete')
    // ...and the real collectCadParts/complete filter kept p1 out of it.
    expect(generatedRuns[1]).toEqual(['p2'])

    const artifacts = (await reload()).artifacts
    expect(statusOf(artifacts, 'p1')).toMatchObject({ status: 'complete' })
    expect(statusOf(artifacts, 'p2')).toMatchObject({ status: 'complete' })
  })

  it('reports the parts that generated, not the parts that were tried', async () => {
    failTempIds.add('p2')

    await runStage()

    const state = (await reload()).artifacts?.cadGenerationState
    expect(state).toMatchObject({
      partsTotal: 2,
      partsCompleted: 1,
      partsFailed: 1,
    })
  })
})

describe('generateAllParts resume filter', () => {
  beforeEach(() => {
    agentRuns.length = 0
  })

  it('never re-runs the agent for an already-complete part', async () => {
    const bom = bomWith(leaf('p1'), leaf('p2'))
    const [first, second] = bom.rootAssembly.children
    if (!first || !second) throw new Error('fixture built no leaves')
    first.cadGeneration = {
      status: 'complete',
      generationMethod: 'freecad',
      stepFileKey: 'vault-p1',
    }

    const events: Array<StageEvent> = []
    for await (const event of realGenerateAllParts(bom.rootAssembly, {
      concurrency: 2,
      tempIdToItemId: new Map([
        ['p1', 'item-p1'],
        ['p2', 'item-p2'],
      ]),
      userId: '33333333-3333-4333-8333-333333333333',
    })) {
      events.push(event)
    }

    expect(agentRuns).toEqual([{ partName: 'Part p2', itemId: 'item-p2' }])
    // The finished part's vault pointer survives untouched.
    expect(first.cadGeneration.stepFileKey).toBe('vault-p1')
    expect(second.cadGeneration).toMatchObject({
      status: 'complete',
      generationMethod: 'freecad',
      stepFileKey: 'vault-item-p2',
      iterations: 1,
    })
    expect(
      events.some(
        (e) => e.type === 'llm_text' && e.text.includes('Skipping 1 part(s)'),
      ),
    ).toBe(true)
  })
})
