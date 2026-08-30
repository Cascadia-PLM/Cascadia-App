// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { collectionQuery } from './entities'
import type {
  WorkflowDefinition,
  WorkflowState,
  WorkflowTransition,
} from '@/lib/workflows/types'
import type {
  ChangeActionMappings,
  LifecyclePhaseConfig,
  RevisionScheme,
} from '@/lib/types/lifecycle'
import { apiFetch } from '@/lib/api/client'

/**
 * The definition governing an item type, as `/lifecycles/by-item-type`
 * serves it: everything a client needs to render states by configuration and
 * to derive the released family. `lifecycleId` is null when the type has no
 * assigned definition.
 */
export interface ItemTypeLifecycle {
  lifecycleId: string | null
  name: string | null
  lifecycleType: 'Free' | 'Driven' | 'Driving' | null
  phases: Array<LifecyclePhaseConfig>
  states: Array<WorkflowState>
  transitions: Array<WorkflowTransition>
  revisionScheme: RevisionScheme | null
  changeActionMappings: ChangeActionMappings
}

/**
 * The lifecycle governing an item type. Loader-safe (route loaders prime it
 * with `ensureQueryData`, e.g. to learn which states to count) and shared by
 * components that render states or build state pickers. Keyed under
 * `lifecycles`, so a lifecycle edit invalidates it.
 */
export function lifecycleByItemTypeQuery(itemType: string) {
  return queryOptions({
    queryKey: qk.sub('lifecycles', 'by-item-type', itemType),
    queryFn: async (): Promise<ItemTypeLifecycle> => {
      const result = await apiFetch<{ data: ItemTypeLifecycle }>(
        `/api/v1/lifecycles/by-item-type/${encodeURIComponent(itemType)}`,
      )
      return result.data
    },
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * The states the release machinery can leave a version in — release and
 * revise targets plus what obsolescence and supersession stamp — derived
 * from a lifecycle's change-action mappings exactly as the server's
 * `getReleasedFamilyStates` does. Empty for Free lifecycles. Never key off
 * a state's name.
 */
export function releasedFamilyStateIds(
  lifecycle: Pick<ItemTypeLifecycle, 'changeActionMappings'> | null | undefined,
): Array<string> {
  const m = lifecycle?.changeActionMappings
  if (!m) return []
  return [
    ...new Set(
      [
        m.release?.toState,
        m.revise?.newVersionState,
        m.revise?.oldVersionState,
        m.obsolete?.toState,
      ].filter((s): s is string => typeof s === 'string' && s.length > 0),
    ),
  ]
}

/**
 * Every workflow definition — item lifecycles and change-order workflows are
 * one unified list behind `/api/v1/workflows`.
 *
 * Keyed under `workflows` because that is the endpoint it reads; invalidating
 * `lifecycles` reaches it too, since `lifecycles` names `workflows` as a
 * dependent.
 */
/**
 * The free-lifecycle transitions available from an item's current state.
 *
 * Keyed beneath the item, so a transition — which invalidates `items` —
 * refreshes the control that offers the next ones.
 */
export function itemTransitionsQuery<T>(
  itemId: string,
  /** The state they are available *from*; part of the key. */
  state?: string | null,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('items', itemId, 'transitions', state ?? undefined),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: { transitions?: Array<T> } }>(
        `/api/v1/items/${itemId}/transitions`,
      )
      return result.data.transitions ?? []
    },
    enabled: enabled && Boolean(itemId),
  })
}

export function lifecycleListQuery() {
  return collectionQuery<WorkflowDefinition>('workflows', 'workflows')
}
