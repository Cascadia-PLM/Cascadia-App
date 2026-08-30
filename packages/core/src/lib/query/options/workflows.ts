// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type {
  AvailableTransition,
  StateApprover,
  WorkflowDefinition,
} from '@/lib/workflows/types'
import { apiFetch } from '@/lib/api/client'

export interface WorkflowInstance {
  id: string
  workflowDefinitionId: string
  itemId: string
  currentState: string
  completedAt: string | null
}

export interface WorkflowState {
  instance: WorkflowInstance | null
  definition: WorkflowDefinition | null
}

const NO_WORKFLOW: WorkflowState = { instance: null, definition: null }

/**
 * The workflow instance and definition driving a change order.
 *
 * Keyed under the change order rather than under `workflows`, because that
 * is the entity it belongs to — invalidating either resource reaches it, since
 * `workflows` lists `change-orders` as a dependent.
 */
/**
 * One workflow (lifecycle) definition by id.
 *
 * The lifecycle editor seeds its editable copy from this; the admin list
 * reads the same `workflows` resource, so a save refreshes both.
 */
export function workflowDefinitionQuery<T>(id: string, enabled = true) {
  return queryOptions({
    queryKey: qk.detail('workflows', id),
    queryFn: async (): Promise<T> => {
      const result = await apiFetch<{ data: { workflow: T } }>(
        `/api/v1/workflows/${id}`,
      )
      return result.data.workflow
    },
    enabled: enabled && Boolean(id),
  })
}

export function changeOrderWorkflowQuery(itemId: string) {
  return queryOptions({
    queryKey: qk.sub('change-orders', itemId, 'workflow'),
    queryFn: async (): Promise<WorkflowState> => {
      const result = await apiFetch<{ data?: WorkflowState }>(
        `/api/v1/change-orders/${itemId}/workflow`,
      )
      // An item with no workflow attached still returns 200.
      return result.data ?? NO_WORKFLOW
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
 * Who must approve one state of a workflow definition.
 *
 * Keyed beneath the definition and under the state, so editing one state's
 * approvers does not evict another's, while invalidating `workflows` reaches
 * every one of them.
 */
export function stateApproversQuery(
  workflowDefinitionId: string,
  stateId: string,
) {
  return queryOptions({
    queryKey: qk.sub(
      'workflows',
      workflowDefinitionId,
      'state-approvers',
      stateId,
    ),
    queryFn: async (): Promise<Array<StateApprover>> => {
      const result = await apiFetch<{
        data: { approvers: Array<StateApprover> }
      }>(
        `/api/v1/workflows/${workflowDefinitionId}/states/${stateId}/approvers`,
      )
      return result.data.approvers
    },
  })
}
