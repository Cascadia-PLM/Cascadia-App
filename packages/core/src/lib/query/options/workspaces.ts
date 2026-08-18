// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { collectionQuery, entitySubQuery } from './entities'
import { apiFetch } from '@/lib/api/client'

/** A workspace branch as the list endpoint returns it, joined to its design. */
export interface Workspace {
  id: string
  name: string
  designId: string
  designName: string
  createdAt: string | Date
  isLocked: boolean | null
  isArchived: boolean | null
  ownerId: string | null
}

/** Every workspace branch owned by the current user. */
export function workspaceListQuery() {
  return collectionQuery<Workspace>('workspaces', 'workspaces')
}

export interface WorkspaceDetail extends Workspace {
  designCode: string
  headCommitId: string | null
  baseCommitId: string | null
  /** Every item on the branch, untouched checkouts included — what convert/merge would carry. */
  itemCount: number
  /** Items created on this workspace and existing nowhere else — what deleting it would destroy. */
  workspaceOnlyItemCount: number
}

/**
 * One workspace.
 *
 * The detail endpoint returns the record directly under `data` rather than
 * under a singular key, so `entityQuery` does not fit.
 */
export function workspaceDetailQuery(id: string) {
  return queryOptions({
    queryKey: qk.detail('workspaces', id),
    queryFn: async (): Promise<WorkspaceDetail> => {
      const result = await apiFetch<{ data: WorkspaceDetail }>(
        `/api/v1/workspaces/${id}`,
      )
      return result.data
    },
  })
}

/**
 * An item on a workspace branch. The item fields come from a left join and a
 * null `changeType` is an untouched checkout, so several fields are nullable
 * in shapes the UI has to survive rather than states it can rely on.
 */
export interface WorkspaceItem {
  id: string
  itemId: string | null
  itemMasterId: string
  itemNumber: string | null
  itemName: string | null
  itemType: string | null
  revision: string | null
  state: string | null
  changeType: 'added' | 'modified' | 'deleted' | null
  checkedOutBy: string | null
  checkedOutAt: string | Date | null
}

/** Everything checked out onto one workspace. */
export function workspaceItemsQuery(id: string) {
  return entitySubQuery<WorkspaceItem>('workspaces', id, 'items', 'items')
}

export interface WorkspaceCommit {
  id: string
  message: string | null
  createdAt: string | Date
}

/**
 * A workspace's commit history.
 *
 * A workspace *is* a branch, so the history is served by the branches
 * endpoint and keyed under `branches` — which is what makes committing on a
 * workspace refresh it.
 */
export function workspaceCommitsQuery(id: string) {
  return entitySubQuery<WorkspaceCommit>('branches', id, 'commits', 'commits')
}
