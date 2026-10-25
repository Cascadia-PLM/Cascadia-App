// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { defineProgression } from './progression'

describe('declared typed progression', () => {
  it('invalidates retained aliases and returns evidence for the accepted edge', () => {
    const machine = defineProgression({
      ready: { execute: 'running' },
      running: { retry: 'ready', finish: 'done' },
      done: {},
    })
    const ready = machine.start('ready')
    const running = ready.transition('execute')
    expect(running.kind).toBe('advanced')
    expect(ready.transition('execute')).toEqual({ kind: 'stale' })
    if (running.kind !== 'advanced')
      throw new Error('Fixture transition failed')
    const done = running.phase.transition('finish')
    if (done.kind !== 'advanced') throw new Error('Fixture transition failed')
    expect(done.evidence).toEqual({
      from: 'running',
      command: 'finish',
      to: 'done',
    })
    void (() => {
      // @ts-expect-error Cannot skip the execution phase.
      ready.transition('finish')
      // @ts-expect-error A terminal phase exposes no transition.
      done.phase.transition('execute')
    })
  })

  it('rejects unknown commands and preserves the declaration against mutation', () => {
    const declaration = { ready: { execute: 'done' }, done: {} } as const
    const machine = defineProgression(declaration)
    const ready = machine.start('ready')
    // @ts-expect-error Runtime callers do not gain authority by bypassing types.
    expect(ready.transition('toString')).toEqual({ kind: 'invalid' })
    Object.assign(declaration.ready, { execute: 'missing' })
    const next = ready.transition('execute')
    expect(next.kind === 'advanced' && next.phase.state).toBe('done')
  })
})
