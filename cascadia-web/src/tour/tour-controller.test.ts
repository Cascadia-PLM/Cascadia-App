// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { createTourController } from './tour-controller'
import { tourProgression } from './tour-progression'
import type { TourAcknowledgement } from './tour-progression'

function createFixture(
  hooks: {
    onAcquire?: () => void
    onShow?: () => void
    onRecord?: () => void
  } = {},
) {
  let completed = false
  const errors: Array<unknown> = []
  const acknowledgements: Array<TourAcknowledgement> = []
  const presentations: Array<{
    shown: boolean
    destroyed: boolean
    acknowledge: () => void
  }> = []
  const controller = createTourController({
    presentation: ({ onAcknowledge }) => {
      hooks.onAcquire?.()
      const presentation = {
        shown: false,
        destroyed: false,
        acknowledge: onAcknowledge,
      }
      presentations.push(presentation)
      return {
        show() {
          hooks.onShow?.()
          presentation.shown = true
        },
        destroy() {
          presentation.destroyed = true
          // A hostile vendor firing its close hook during cleanup must not
          // turn disposal into acknowledgement.
          onAcknowledge()
        },
      }
    },
    completion: {
      isCompleted: () => completed,
      record(evidence) {
        hooks.onRecord?.()
        completed = true
        acknowledgements.push(evidence)
      },
      clear() {
        completed = false
      },
      isAutomaticStartSuppressed: () => false,
    },
    onChange: () => undefined,
    onError: (error) => errors.push(error),
  })
  return { controller, presentations, errors, acknowledgements }
}

describe('tour controller boundary failures', () => {
  // Compile-only contract: cancellation cannot be persisted as acknowledgement.
  void (() => {
    const starting = tourProgression.start('idle').commands.start()
    if (starting.kind !== 'advanced') return
    const active = starting.phase.commands.activate()
    if (active.kind !== 'advanced') return
    const cancelled = active.phase.commands.cancel()
    if (cancelled.kind !== 'advanced') return
    const record = (_evidence: TourAcknowledgement) => undefined
    // @ts-expect-error Cancellation evidence has no acknowledgement authority.
    record(cancelled.evidence)
  })
  it('reserves admission before presentation acquisition can reenter', async () => {
    const fixture = createFixture({
      onAcquire: () => {
        fixture.controller.start()
        fixture.controller.reset()
      },
    })
    fixture.controller.start()
    expect(fixture.presentations).toHaveLength(1)
    expect(fixture.controller.snapshot().isTourActive).toBe(true)
    await fixture.controller.dispose()
    expect(fixture.acknowledgements).toEqual([])
  })

  it('rejects callbacks from an old presentation after reset', async () => {
    const fixture = createFixture()
    fixture.controller.start()
    const oldPresentation = fixture.presentations[0]!
    fixture.controller.reset()
    oldPresentation.acknowledge()
    expect(oldPresentation.destroyed).toBe(true)
    expect(fixture.presentations[1]?.destroyed).toBe(false)
    expect(fixture.controller.snapshot()).toEqual({
      hasCompletedTour: false,
      isTourActive: true,
    })
    await fixture.controller.dispose()
  })

  it('disposes an acquisition that completes after the controller was closed', async () => {
    const fixture = createFixture({
      onAcquire: () => {
        void fixture.controller.dispose()
      },
    })
    fixture.controller.start()
    fixture.controller.start()
    expect(fixture.presentations).toHaveLength(1)
    expect(fixture.presentations[0]).toMatchObject({
      shown: false,
      destroyed: true,
    })
    expect(fixture.controller.snapshot().isTourActive).toBe(false)
    await fixture.controller.dispose()
  })

  it('releases failed admission so a later manual start can recover', async () => {
    const failure = new Error('Vendor construction failed')
    let rejectAcquisition = true
    const fixture = createFixture({
      onAcquire() {
        if (rejectAcquisition) throw failure
      },
    })
    fixture.controller.start()
    expect(fixture.controller.snapshot().isTourActive).toBe(false)
    rejectAcquisition = false
    fixture.controller.start()
    expect(fixture.controller.snapshot().isTourActive).toBe(true)
    expect(fixture.errors).toEqual([failure])
    await fixture.controller.dispose()
  })

  it('cleans up a failed activation without recording completion', async () => {
    const failure = new Error('Vendor activation failed')
    const fixture = createFixture({
      onShow: () => {
        throw failure
      },
    })
    fixture.controller.start()
    await Promise.resolve()
    expect(fixture.presentations[0]?.destroyed).toBe(true)
    expect(fixture.controller.snapshot()).toEqual({
      hasCompletedTour: false,
      isTourActive: false,
    })
    expect(fixture.errors).toEqual([failure])
    await fixture.controller.dispose()
  })

  it('closes on persistence failure and blocks reentrant startup while settling', async () => {
    const failure = new Error('Persistence failed')
    const fixture = createFixture({
      onRecord() {
        fixture.controller.start()
        throw failure
      },
    })
    fixture.controller.start()
    fixture.presentations[0]!.acknowledge()
    expect(fixture.presentations).toHaveLength(1)
    expect(fixture.presentations[0]?.destroyed).toBe(true)
    expect(fixture.controller.snapshot().isTourActive).toBe(false)
    expect(fixture.errors).toEqual([failure])
    await fixture.controller.dispose()
  })
})
