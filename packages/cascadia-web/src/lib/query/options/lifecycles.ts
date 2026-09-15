// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { collectionQuery } from './entities'
import type {
  AvailableTransition,
  LifecycleDefinition,
  LifecycleState,
  LifecycleTransition,
  StateApprover,
} from '@/lib/lifecycles/types'
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
  states: Array<LifecycleState>
  transitions: Array<LifecycleTransition>
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

/**
 * Every lifecycle definition — item lifecycles and change-order workflows are
 * one list behind `/api/v1/lifecycles`. The response key is still
 * `workflows`, the v1 spelling.
 */
export function lifecycleListQuery() {
  return collectionQuery<LifecycleDefinition>('lifecycles', 'workflows')
}

export interface ChangeOrderLifecycleInstance {
  id: string
  workflowDefinitionId: string
  itemId: string
  currentState: string
  completedAt: string | null
}

export interface ChangeOrderLifecycle {
  instance: ChangeOrderLifecycleInstance | null
  definition: LifecycleDefinition | null
}

const NO_LIFECYCLE: ChangeOrderLifecycle = { instance: null, definition: null }

/**
 * One lifecycle definition by id.
 *
 * The lifecycle editor seeds its editable copy from this; the admin list
 * reads the same `lifecycles` resource, so a save refreshes both.
 */
export function lifecycleDefinitionQuery<T>(id: string, enabled = true) {
  return queryOptions({
    queryKey: qk.detail('lifecycles', id),
    queryFn: async (): Promise<T> => {
      const result = await apiFetch<{ data: { workflow: T } }>(
        `/api/v1/lifecycles/${id}`,
      )
      return result.data.workflow
    },
    enabled: enabled && Boolean(id),
  })
}

/**
 * The lifecycle instance and definition driving a change order.
 *
 * Keyed under the change order rather than under `lifecycles`, because that
 * is the entity it belongs to — invalidating either resource reaches it, since
 * `lifecycles` lists `change-orders` as a dependent.
 */
export function changeOrderLifecycleQuery(itemId: string) {
  return queryOptions({
    queryKey: qk.sub('change-orders', itemId, 'workflow'),
    queryFn: async (): Promise<ChangeOrderLifecycle> => {
      const result = await apiFetch<{ data?: ChangeOrderLifecycle }>(
        `/api/v1/change-orders/${itemId}/workflow`,
      )
      // An item with no workflow attached still returns 200.
      return result.data ?? NO_LIFECYCLE
    },
  })
}

/** Transitions currently available to the acting user on a change order. */
export function changeOrderTransitionsQuery(itemId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('change-orders', itemId, 'workflow-transitions'),
    queryFn: async (): Promise<Array<AvailableTransition>> => {
      const result = await apiFetch<{
        data: { transitions: Array<AvailableTransition> }
      }>(`/api/v1/change-orders/${itemId}/workflow/transition`)
      return result.data.transitions
    },
    // Only meaningful once we know the item has a workflow instance.
    enabled,
  })
}

/**
 * Who must approve one state of a lifecycle definition.
 *
 * Keyed beneath the definition and under the state, so editing one state's
 * approvers does not evict another's, while invalidating `lifecycles` reaches
 * every one of them.
 */
export function stateApproversQuery(
  workflowDefinitionId: string,
  stateId: string,
) {
  return queryOptions({
    queryKey: qk.sub(
      'lifecycles',
      workflowDefinitionId,
      'state-approvers',
      stateId,
    ),
    queryFn: async (): Promise<Array<StateApprover>> => {
      const result = await apiFetch<{
        data: { approvers: Array<StateApprover> }
      }>(
        `/api/v1/lifecycles/${workflowDefinitionId}/states/${stateId}/approvers`,
      )
      return result.data.approvers
    },
  })
}
