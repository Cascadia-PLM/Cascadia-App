// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createOwnedLifetime } from '@cascadia/commons/managed-resources'
import type {
  LifetimeOwner,
  ResourceLifetime,
} from '@cascadia/commons/managed-resources'

/** Attachment and declared identity own replacement; observers stay current. */
export function useOwnedElement<
  TInput,
  TEvent = never,
  TElement extends HTMLElement = HTMLDivElement,
>(
  identity: TInput,
  setup: (
    element: TElement,
    lifetime: ResourceLifetime,
    emit: (event: TEvent) => void,
  ) => void | PromiseLike<void>,
  onEvent?: (event: TEvent) => void,
) {
  const [element, setElement] = useState<TElement | null>(null)
  const committedOwner = useRef<LifetimeOwner | null>(null)
  const acquire = useEffectEvent(setup)
  const notify = useEffectEvent((event: TEvent) => onEvent?.(event))
  const attach = useCallback((node: TElement | null) => {
    // Detachment invalidates callbacks immediately, before a replacement commit.
    if (node === null) {
      void committedOwner.current?.dispose()
      committedOwner.current = null
    }
    setElement(node)
  }, [])

  useLayoutEffect(() => {
    if (!element) return
    const owner = createOwnedLifetime((error) =>
      console.warn('Element resource:', error),
    )
    committedOwner.current = owner
    void owner.run((lifetime) =>
      acquire(
        element,
        lifetime,
        lifetime.guard((event: TEvent) => notify(event)),
      ),
    )
    return () => {
      void owner.dispose()
      if (committedOwner.current === owner) committedOwner.current = null
    }
  }, [identity, element])
  return attach
}
