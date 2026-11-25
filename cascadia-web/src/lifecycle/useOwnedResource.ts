// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffectEvent, useLayoutEffect, useState } from 'react'
import { createOwnedLifetime } from '@cascadia/commons/managed-resources'
import type { ResourceLifetime } from '@cascadia/commons/managed-resources'

export type OwnedResourceState<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'failed'; error: unknown }

/** Input identity owns replacement; callback updates do not restart acquisition. */
export function useOwnedResource<TInput, TValue>(
  input: TInput | null,
  setup: (
    input: TInput,
    lifetime: ResourceLifetime,
  ) => TValue | PromiseLike<TValue>,
  observer?: {
    ready?: (value: TValue) => void
    failed?: (error: unknown) => void
  },
): OwnedResourceState<TValue> {
  const acquire = useEffectEvent(setup)
  const onReady = useEffectEvent((value: TValue) => observer?.ready?.(value))
  const onFailure = useEffectEvent((error: unknown) =>
    observer?.failed?.(error),
  )
  const [settled, setSettled] = useState<{
    input: TInput
    signal: AbortSignal
    state: OwnedResourceState<TValue>
  } | null>(null)

  useLayoutEffect(() => {
    if (input === null) return
    const owner = createOwnedLifetime((error) =>
      console.warn('Resource cleanup:', error),
    )
    const signal = owner.context.signal
    setSettled({ input, signal, state: { kind: 'loading' } })
    void owner.run(
      (lifetime) => acquire(input, lifetime),
      (value) => {
        setSettled({ input, signal, state: { kind: 'ready', value } })
        onReady(value)
      },
      (error) => {
        setSettled({ input, signal, state: { kind: 'failed', error } })
        onFailure(error)
      },
    )
    return () => {
      void owner.dispose()
    }
  }, [input])

  if (input === null) return { kind: 'idle' }
  return settled !== null &&
    Object.is(settled.input, input) &&
    (settled.state.kind === 'failed' || !settled.signal.aborted)
    ? settled.state
    : { kind: 'loading' }
}
