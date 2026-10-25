// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffectEvent, useLayoutEffect } from 'react'
import { createOwnedLifetime } from '@cascadia/commons/managed-resources'
import type { ResourceLifetime } from '@cascadia/commons/managed-resources'

/** A resource synchronization without a React result projection. */
export function useOwnedEffect<TInput>(
  input: TInput | null,
  setup: (
    input: TInput,
    lifetime: ResourceLifetime,
  ) => void | PromiseLike<void>,
  parent?: ResourceLifetime,
) {
  const acquire = useEffectEvent(setup)
  useLayoutEffect(() => {
    if (input === null) return
    const owner = createOwnedLifetime(
      (error) => console.warn('Resource effect:', error),
      parent,
    )
    void owner.run(
      (lifetime) => acquire(input, lifetime),
      () => undefined,
    )
    return () => {
      void owner.dispose()
    }
  }, [input, parent])
}
