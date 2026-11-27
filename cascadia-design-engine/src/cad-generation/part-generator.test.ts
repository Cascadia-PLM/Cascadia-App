// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Poll-loop cancellation (AI2-7), and progress relay.
 *
 * The parametric and mechanism generators submit a RabbitMQ job and then poll
 * `JobService.get` on a fixed interval until the job resolves or a 60s/120s
 * budget runs out. Neither loop looked at `options.signal`, so an abort was
 * observed only by whatever was draining the stage generator — the poll itself
 * ran on, holding a concurrency slot and keeping the stage alive minutes past
 * the request that started it.
 *
 * Timing is the assertion here because the defect *is* a timing one: the
 * measurable difference between "stops on the next poll" and "stops when the
 * budget expires" is the whole fix. The poll count is the sharper half of it —
 * a run to the 60s cap is 120 polls, not one.
 *
 * The FreeCAD agent's progress lines ride the same pool, so the second block
 * pins that they reach the consumer while the part is still generating.
 *
 * Run: npx vitest run cascadia-design-engine/src/cad-generation/part-generator.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BomNodeDraft, StageEvent } from '@/design-engine/types'
import type { FreecadAgentOptions } from './freecad-agent'

const jobGet = vi.fn<(id: string) => Promise<unknown>>()
const jobSubmit = vi.fn(() => Promise.resolve({ id: 'job-1' }))

vi.mock('@/jobs/JobService', () => ({
  JobService: { submit: jobSubmit, get: jobGet },
}))

/** Scripted behaviour of the (mocked) FreeCAD agent, set per test. */
let agentBehaviour: (options: FreecadAgentOptions) => Promise<unknown> = () =>
  Promise.reject(new Error('unexpected agent call'))

vi.mock('./freecad-agent', () => ({
  generatePartWithFreecad: (options: FreecadAgentOptions) =>
    agentBehaviour(options),
}))

const { generateAllParts } = await import('./part-generator')

/** A one-part BOM whose only leaf takes the parametric path. */
function parametricTree(): BomNodeDraft {
  const child: BomNodeDraft = {
    tempId: 'part-1',
    name: 'Spacer',
    isNew: true,
    quantity: 1,
    children: [],
    requirementTempIds: [],
    partType: 'Manufacture',
    rationale: 'Sets the shaft standoff',
    confidence: 1,
    parametricSpec: {
      shapeTemplate: 'spacer',
      parameters: { outerDiameter: 20, innerDiameter: 8, length: 12 },
      units: 'mm',
    },
  }
  return {
    tempId: 'assembly-1',
    name: 'Carriage',
    isNew: true,
    quantity: 1,
    children: [child],
    requirementTempIds: [],
    partType: 'Manufacture',
    rationale: 'Root',
    confidence: 1,
  }
}

/** A one-part BOM whose only leaf takes the FreeCAD agent path. */
function freecadTree(): BomNodeDraft {
  const tree = parametricTree()
  const child = tree.children[0]
  if (child) {
    delete child.parametricSpec
    child.name = 'Bracket'
    child.material = 'Aluminum 6061'
  }
  return tree
}

async function drive(
  tree: BomNodeDraft,
  signal?: AbortSignal,
): Promise<Array<StageEvent>> {
  const events: Array<StageEvent> = []
  for await (const event of generateAllParts(tree, {
    tempIdToItemId: new Map([['part-1', 'item-1']]),
    branchId: 'branch-1',
    userId: 'user-1',
    signal,
  })) {
    events.push(event)
  }
  return events
}

describe('generateAllParts parametric polling', () => {
  beforeEach(() => {
    jobGet.mockReset()
    jobSubmit.mockClear()
  })

  it('stops polling on the next tick once the caller aborts', async () => {
    const controller = new AbortController()
    // The job never finishes; the caller goes away while the first poll is in
    // flight, which is what a closed SSE stream looks like from in here.
    jobGet.mockImplementation(() => {
      controller.abort()
      return Promise.resolve({ id: 'job-1', status: 'running' })
    })

    const startedAt = Date.now()
    const events = await drive(parametricTree(), controller.signal)
    const elapsedMs = Date.now() - startedAt

    // One poll, then the loop's abort check ends it. Polling to the 60s
    // budget would be ~120.
    expect(jobGet).toHaveBeenCalledTimes(1)
    expect(elapsedMs).toBeLessThan(5_000)

    // Reported through the per-part failure channel the generator already
    // uses, so the stage's counters and the node's status stay consistent.
    expect(
      events.some((e) => e.type === 'llm_text' && e.text.includes('Cancelled')),
    ).toBe(true)
  })

  it('polls on past a signal that never fires', async () => {
    const controller = new AbortController()
    let polls = 0
    jobGet.mockImplementation(() => {
      polls++
      return Promise.resolve(
        polls < 2
          ? { id: 'job-1', status: 'running' }
          : {
              id: 'job-1',
              status: 'completed',
              result: { partTempId: 'part-1', vaultFileId: 'vault-1' },
            },
      )
    })

    const events = await drive(parametricTree(), controller.signal)

    expect(jobGet).toHaveBeenCalledTimes(2)
    expect(
      events.some(
        (e) => e.type === 'llm_text' && e.text.includes('Part CAD generated'),
      ),
    ).toBe(true)
  })
})

describe('generateAllParts FreeCAD agent relay', () => {
  it("streams the agent's progress before the part finishes", async () => {
    agentBehaviour = async (options) => {
      options.onProgress?.({
        phase: 'attempt',
        attempt: 1,
        maxAttempts: 6,
        text: 'Attempt 1/6: running FreeCAD script (12 lines)',
      })
      // Let the pool observe the progress line before the result lands.
      await new Promise((resolve) => setTimeout(resolve, 20))
      options.onProgress?.({
        phase: 'result',
        attempt: 1,
        maxAttempts: 6,
        text: 'Attempt 1/6: geometry valid — 1 solid, 40.0 × 20.0 × 5.0 mm, 4,000 mm³',
      })
      return {
        success: true,
        vaultFileId: 'vault-1',
        fileName: 'Bracket.step',
        script: 'import Part\nresult = Part.makeBox(40, 20, 5)\n',
        iterations: 1,
        boundingBox: { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 20, maxZ: 5 },
      }
    }

    const tree = freecadTree()
    const events = await drive(tree)
    const texts = events
      .filter(
        (e): e is Extract<StageEvent, { type: 'llm_text' }> =>
          e.type === 'llm_text',
      )
      .map((e) => e.text)

    // Progress lines are prefixed with the part and precede the result line.
    const attemptIndex = texts.findIndex((t) =>
      t.startsWith('Bracket: Attempt 1/6: running'),
    )
    const resultIndex = texts.findIndex((t) =>
      t.includes('Part CAD generated: part-1'),
    )
    expect(attemptIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(attemptIndex)
    expect(texts[resultIndex]).toContain('(1 attempt)')

    // The node carries the script and the attempt count for the review panel
    // and for a later regeneration to revise.
    expect(tree.children[0]?.cadGeneration).toMatchObject({
      status: 'complete',
      generationMethod: 'freecad',
      stepFileKey: 'vault-1',
      iterations: 1,
      generationScript: 'import Part\nresult = Part.makeBox(40, 20, 5)\n',
    })
  })

  it('reports an agent failure as a per-part failure with the reason', async () => {
    agentBehaviour = () =>
      Promise.resolve({
        success: false,
        errorMessage:
          'FreeCAD generation failed after 6 attempts: BRep_API: command not done',
        iterations: 6,
        lastScript: 'import Part\n',
      })

    const tree = freecadTree()
    const events = await drive(tree)

    expect(tree.children[0]?.cadGeneration).toMatchObject({
      status: 'failed',
      generationMethod: 'freecad',
      iterations: 6,
    })
    expect(
      events.some(
        (e) =>
          e.type === 'llm_text' &&
          e.text.includes(
            'Part CAD failed: part-1 (6 attempts) - FreeCAD generation failed',
          ),
      ),
    ).toBe(true)
  })
})
