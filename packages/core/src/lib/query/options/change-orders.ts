// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { entityQuery, entitySubQuery } from './entities'
import type {
  AffectedItem,
  ChangeActionOptions,
  ChangeOrder,
} from '@/lib/items/types/change-order'
import type { BaseItem } from '@/lib/items/types/base'
import type {
  ApprovalsByState,
  CanApproveResult,
  EffectiveWorkflowStructure,
} from '@/lib/workflows/types'
import { apiFetch } from '@/lib/api/client'

/**
 * One change order.
 *
 * Shares the key the `/change-orders/$id` loader primes, so a panel nested in
 * the detail page reads it from cache instead of refetching.
 */
export function changeOrderDetailQuery(id: string) {
  return entityQuery<ChangeOrder>('change-orders', id, 'changeOrder')
}

/** A change order as the `/change-orders/editable` endpoint lists it. */
export interface EditableChangeOrder {
  id: string
  itemNumber: string
  name: string | null
  state: string
  changeType: string
}

/**
 * Change orders that can still accept affected items (scope not locked),
 * optionally narrowed to one design. Drives the "merge workspace into an
 * existing ECO" picker.
 */
export function editableChangeOrdersQuery(designId?: string) {
  return queryOptions({
    queryKey: qk.list('change-orders', { editable: true, designId }),
    queryFn: async (): Promise<Array<EditableChangeOrder>> => {
      const params = new URLSearchParams()
      if (designId) params.set('designId', designId)
      const result = await apiFetch<{
        data: { changeOrders: Array<EditableChangeOrder> }
      }>(`/api/v1/change-orders/editable?${params}`)
      return result.data.changeOrders
    },
  })
}

/** A design pulled into an ECO, joined to the design it points at. */
export interface EcoDesign {
  id: string
  changeOrderId: string
  designId: string
  branchId: string | null
  mergeStatus: string | null
  designName: string
  designCode: string
  designType: string
}

/**
 * Designs an ECO touches, one ECO branch each — as far as this caller can see.
 *
 * Returns the envelope rather than the bare list because `hasRestricted` is
 * the other half of the answer: a change order can reach designs in programs
 * the caller is not in, and those are withheld from `designs`. Dropping the
 * flag on the floor here would turn a deliberate redaction into a silent one,
 * which is the failure this whole boundary is built to avoid — a reviewer who
 * cannot tell the difference between "this ECO affects one design" and "this
 * ECO affects one design that you can see".
 *
 * Anonymous by design: no count, no names. Someone who did not expect the
 * boundary asks for access to whatever else the ECO touches.
 */
export interface EcoDesignScope {
  designs: Array<EcoDesign>
  hasRestricted: boolean
}

export function changeOrderDesignsQuery(id: string) {
  return queryOptions({
    queryKey: qk.sub('change-orders', id, 'designs'),
    queryFn: async (): Promise<EcoDesignScope> => {
      const result = await apiFetch<{ data: EcoDesignScope }>(
        `/api/v1/change-orders/${id}/designs`,
      )
      return result.data
    },
  })
}

/** An affected-item row with the item it points at resolved. */
export type EcoAffectedItem = AffectedItem & { affectedItemDetails?: BaseItem }

/** Items an ECO affects, with the change action recorded for each. */
export function changeOrderAffectedItemsQuery(id: string) {
  return entitySubQuery<EcoAffectedItem>(
    'change-orders',
    id,
    'affected-items',
    'affectedItems',
  )
}

export interface ChangeOrderApprovals {
  instanceId: string
  currentState: string
  approvals: ApprovalsByState
  canApprove: CanApproveResult
}

/**
 * Approval votes on a change order's workflow instance, plus whether the
 * acting user may vote at the current state.
 *
 * The endpoint returns the record directly under `data` rather than under a
 * named key, so `entitySubQuery` does not fit.
 */
export function changeOrderApprovalsQuery(id: string) {
  return queryOptions({
    queryKey: qk.sub('change-orders', id, 'approvals'),
    queryFn: async (): Promise<ChangeOrderApprovals> => {
      const result = await apiFetch<{ data: ChangeOrderApprovals }>(
        `/api/v1/change-orders/${id}/approvals`,
      )
      return result.data
    },
  })
}

export interface EcoDesignSummary {
  designId: string
  designCode: string
  designName: string
  branch: { id: string; name: string } | null
  itemsAffected: number
  itemsModified: number
  itemsAdded: number
  itemsDeleted: number
  hasCheckedOutItems: boolean
}

export interface EcoSummary {
  changeOrder: {
    id: string
    itemNumber: string
    name: string | null
    state: string
  }
  designs: Array<EcoDesignSummary>
  totalItemsAffected: number
  canSubmit: boolean
  canRelease: boolean
  validationIssues?: Array<string>
}

/** Rollup of an ECO's designs, branch churn and release readiness. */
export function changeOrderSummaryQuery(id: string) {
  return queryOptions({
    queryKey: qk.sub('change-orders', id, 'summary'),
    queryFn: async (): Promise<EcoSummary> => {
      const result = await apiFetch<{ data: EcoSummary }>(
        `/api/v1/change-orders/${id}/summary`,
      )
      return result.data
    },
  })
}

export type ChangeOrderWorkflowStructure = EffectiveWorkflowStructure & {
  currentState: string
  instanceId: string
}

/**
 * The states and transitions of a change order's workflow instance.
 *
 * A change order with no workflow attached 404s; callers render the empty case
 * from `undefined` rather than from a sentinel.
 */
export function changeOrderWorkflowStructureQuery(id: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('change-orders', id, 'workflow-structure'),
    queryFn: async (): Promise<ChangeOrderWorkflowStructure> => {
      const result = await apiFetch<{ data: ChangeOrderWorkflowStructure }>(
        `/api/v1/change-orders/${id}/workflow/structure`,
      )
      return result.data
    },
    enabled,
  })
}

/**
 * What adding these items to a change order would do — the valid change
 * actions and each one's target state and revision, resolved from every item's
 * own lifecycle.
 *
 * The dialogs used to compute this in the browser from a hardcoded list of the
 * seeded state names. Item ids are sorted into the key so the same selection
 * in a different click order is one cache entry.
 */
export function changeActionOptionsQuery(
  changeOrderId: string,
  itemIds: Array<string>,
) {
  const sortedIds = [...itemIds].sort()
  return queryOptions({
    queryKey: qk.sub(
      'change-orders',
      changeOrderId,
      'change-actions',
      sortedIds.join(','),
    ),
    queryFn: async (): Promise<Array<ChangeActionOptions>> => {
      const result = await apiFetch<{
        data: { options: Array<ChangeActionOptions> }
      }>(`/api/v1/change-orders/${changeOrderId}/affected-items/preview`, {
        method: 'POST',
        body: JSON.stringify({ itemIds: sortedIds }),
      })
      return result.data.options
    },
    enabled: sortedIds.length > 0,
  })
}

export interface EcoDesignStructure<TNode, TOrphan, TBranch> {
  roots: Array<TNode>
  orphans: Array<TOrphan>
  ecoBranch: TBranch | null
}

/**
 * The BOM tree of one design as seen from a change order's branch.
 *
 * Generic in its node types because the tree component owns those shapes.
 * Keyed under the change order, so adding an item to the ECO from any dialog
 * refreshes the tree — it previously relied on a `key=` remount driven by a
 * refresh counter in the parent.
 */
export function ecoDesignStructureQuery<TNode, TOrphan, TBranch>(
  changeOrderId: string,
  designId: string,
) {
  return queryOptions({
    queryKey: qk.sub(
      'change-orders',
      changeOrderId,
      'design-structure',
      designId,
    ),
    queryFn: async (): Promise<EcoDesignStructure<TNode, TOrphan, TBranch>> => {
      const result = await apiFetch<{
        data: EcoDesignStructure<TNode, TOrphan, TBranch>
      }>(`/api/v1/change-orders/${changeOrderId}/designs/${designId}/structure`)
      return {
        roots: result.data.roots,
        orphans: result.data.orphans,
        ecoBranch: result.data.ecoBranch,
      }
    },
  })
}

/**
 * What a release would do, previewed before it happens: the designs it merges
 * and the revision letter each affected item would receive.
 *
 * The shape mirrors the server's `ReleasePreview` (`ChangeOrderMergeService`)
 * but is declared here rather than imported, so no server or database code is
 * pulled into the client bundle.
 */
export interface ReleasePreviewItem {
  itemNumber: string
  currentRevision: string
  newRevision: string
}

export interface ReleasePreview {
  designs?: Array<{
    designId: string
    designName: string
    items?: Array<ReleasePreviewItem>
  }>
  totalItems: number
  canRelease: boolean
  validationIssues?: Array<string>
}

/**
 * Preview of releasing a change order.
 *
 * `enabled` gates it to the moment a releasing transition is actually
 * selected — previewing a cancellation would merge nothing and mislead.
 */
export function changeOrderReleasePreviewQuery(id: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('change-orders', id, 'release-preview'),
    queryFn: async (): Promise<ReleasePreview> => {
      const result = await apiFetch<{ data: ReleasePreview }>(
        `/api/v1/change-orders/${id}/release`,
      )
      return result.data
    },
    enabled,
  })
}

/**
 * Conflicts blocking a change order's release, with each conflicting item
 * resolved for display.
 *
 * Keyed under the change order so resolving one — or anything else that moves
 * branch content — refreshes the panel instead of leaving it on the snapshot
 * an effect happened to load.
 */
export function changeOrderConflictsQuery<T>(id: string) {
  return queryOptions({
    queryKey: qk.sub('change-orders', id, 'conflicts'),
    queryFn: async (): Promise<T> => {
      const result = await apiFetch<{ data: T }>(
        `/api/v1/change-orders/${id}/conflicts`,
      )
      return result.data
    },
  })
}

/**
 * The stored impact report for a change order, or `null` when none has been
 * run yet.
 *
 * A missing report is a normal state rather than a failure — the panel offers
 * to run one — so the 404 is caught here instead of putting the query into an
 * error state the caller would have to translate back.
 */
export function changeOrderImpactReportQuery<T>(id: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('change-orders', id, 'impact-assessment'),
    queryFn: async (): Promise<T | null> => {
      try {
        const result = await apiFetch<{
          data: { impactReport: { reportData: T } }
        }>(`/api/v1/change-orders/${id}/impact-assessment`)
        return result.data.impactReport.reportData
      } catch {
        return null
      }
    },
    enabled,
  })
}

/**
 * The commit graph for one of a change order's ECO branches.
 *
 * `designId` picks which affected design to draw; omitting it lets the server
 * pick the first, and the response lists them all so the caller can offer the
 * switch.
 */
export function changeOrderBranchGraphQuery<T>(
  id: string,
  designId?: string | null,
  limit = 50,
) {
  return queryOptions({
    queryKey: qk.sub('change-orders', id, 'branch-graph', {
      designId: designId ?? null,
      limit,
    }),
    queryFn: async (): Promise<T> => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (designId) params.set('designId', designId)
      const result = await apiFetch<{ data: T }>(
        `/api/v1/change-orders/${id}/branch-history/graph?${params}`,
      )
      return result.data
    },
  })
}

/**
 * Who must approve one state of a change order's own workflow instance.
 *
 * The instance-level counterpart to `stateApproversQuery`: an instance may
 * override the definition's approvers for a single change order.
 */
export function instanceStateApproversQuery<T>(
  changeOrderId: string,
  stateId: string,
) {
  return queryOptions({
    queryKey: qk.sub(
      'change-orders',
      changeOrderId,
      'instance-state-approvers',
      stateId,
    ),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: { approvers: Array<T> } }>(
        `/api/v1/change-orders/${changeOrderId}/workflow/states/${stateId}/approvers`,
      )
      return result.data.approvers
    },
  })
}
