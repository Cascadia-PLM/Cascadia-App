// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { FinalKind } from '@/lib/workflows/types'
import { Button } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { itemTransitionsQuery } from '@/lib/query'

export interface FreeTransitionOption {
  id: string
  name: string
  toStateId: string
  toStateName: string
  toStateColor?: string
  toStateIsFinal?: boolean
  toStateFinalKind?: FinalKind | null
}

interface FreeTransitionControlProps {
  itemId: string
  /** The item's current state; refetches the available transitions when it changes */
  state?: string | null
  /** Called after a transition succeeds, so the caller can refresh its copy */
  onTransitioned?: () => void
  /**
   * Where to send the transition. Defaults to the generic item transition
   * endpoint, which enforces every type's rules. Types with a typed endpoint
   * whose response they want (work orders) pass their own.
   */
  transition?: (option: FreeTransitionOption) => Promise<unknown>
  className?: string
}

/**
 * Free-lifecycle transition control: lists the transitions valid from the
 * item's current state, straight from its lifecycle configuration, and
 * executes them through the transition endpoint — the only sanctioned write
 * path for Free-lifecycle item state (the edit form cannot change it).
 *
 * Renders nothing when there is nothing to do: a Driven item (state changes
 * at change-order release), a final state, or a lifecycle still loading.
 * Button styling keys on the target's `finalKind` flag — never on a name.
 */
export function FreeTransitionControl({
  itemId,
  state,
  onTransitioned,
  transition,
  className,
}: FreeTransitionControlProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Non-fatal by design: without the list the control simply doesn't render.
  // `state` rides the key, so a transition re-asks what is available next.
  const { data: transitions = [] } = useQuery(
    itemTransitionsQuery<FreeTransitionOption>(itemId, state),
  )

  const run = async (option: FreeTransitionOption) => {
    setBusy(true)
    setError(null)
    try {
      if (transition) {
        await transition(option)
      } else {
        await apiFetch(`/api/v1/items/${itemId}/transition`, {
          method: 'POST',
          body: JSON.stringify({ toState: option.toStateId }),
        })
      }
      onTransitioned?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transition failed')
    } finally {
      setBusy(false)
    }
  }

  if (transitions.length === 0) return null

  return (
    <div
      className={`flex gap-1.5 flex-wrap items-center ${className ?? ''}`.trim()}
    >
      {transitions.map((t) => {
        const cancels = t.toStateFinalKind === 'cancel'
        return (
          <Button
            key={t.id}
            type="button"
            size="sm"
            variant={
              cancels ? 'outline' : t.toStateIsFinal ? 'default' : 'outline'
            }
            className={
              cancels
                ? 'text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300'
                : undefined
            }
            disabled={busy}
            onClick={() => run(t)}
            title={`Transition to ${t.toStateName}`}
          >
            {t.name}
          </Button>
        )
      })}
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
    </div>
  )
}
