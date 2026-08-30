// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { gridParamsToSearchParams } from '../grid-params'
import type { GridParams, GridQuery, GridQueryFactory } from '../grid-params'
import { apiFetch } from '@/lib/api/client'

/**
 * Filters that scope an item query to a design, program, or version context.
 *
 * Every item-typed list page (`/parts`, `/documents`, `/requirements`, …)
 * reads through `/api/v1/items` with these, so they share one query-options
 * factory rather than each route hand-rolling a fetch.
 */
export interface ItemFilters {
  itemType?: string
  programId?: string
  designId?: string
  branch?: string
  tag?: string
  commit?: string
  state?: string
  /** Free-text filter the endpoint applies across item number and name. */
  search?: string
}

function applyItemFilters(
  qs: URLSearchParams,
  filters: ItemFilters,
): URLSearchParams {
  if (filters.itemType) qs.set('itemType', filters.itemType)
  if (filters.programId) qs.set('programId', filters.programId)
  if (filters.designId) qs.set('designId', filters.designId)
  if (filters.branch) qs.set('branch', filters.branch)
  if (filters.tag) qs.set('tag', filters.tag)
  if (filters.commit) qs.set('commit', filters.commit)
  if (filters.state) qs.set('state', filters.state)
  if (filters.search) qs.set('search', filters.search)
  return qs
}

/**
 * A paged list of items.
 *
 * The key is derived from `filters` + `grid` only, so a route loader calling
 * `ensureQueryData` with the params it read from the URL primes the exact
 * entry the grid will read.
 */
export function itemListQuery<T>(
  filters: ItemFilters,
  grid: GridParams,
): GridQuery<T> {
  return {
    queryKey: qk.list('items', { ...filters, ...grid }),
    queryFn: async () => {
      const qs = gridParamsToSearchParams(grid)
      applyItemFilters(qs, filters)
      const result = await apiFetch<{
        data: { items: Array<T>; total: number }
      }>(`/api/v1/items?${qs}`)
      return { items: result.data.items, total: result.data.total }
    },
  }
}

/**
 * Curry `itemListQuery` into the factory shape `useServerDataGrid` expects,
 * so a list route and its loader can name the same one-argument function.
 */
export function itemGridQuery<T>(filters: ItemFilters): GridQueryFactory<T> {
  return (grid: GridParams) => itemListQuery<T>(filters, grid)
}

/**
 * Item counts per lifecycle state.
 *
 * `/api/v1/items` computes every requested state in one call via
 * `includeCounts`, replacing the four separate `&state=…` probe requests the
 * list routes used to fire on each load.
 */
export function itemCountsQuery(
  filters: ItemFilters,
  states: ReadonlyArray<string>,
) {
  return queryOptions({
    queryKey: qk.collection('items', 'counts', { ...filters, states }),
    queryFn: async (): Promise<Record<string, number>> => {
      const qs = new URLSearchParams({
        limit: '1',
        includeCounts: 'true',
        countStates: states.join(','),
      })
      applyItemFilters(qs, filters)
      const result = await apiFetch<{
        data: { counts?: Record<string, number> }
      }>(`/api/v1/items?${qs}`)
      const counts = result.data.counts ?? {}
      // Absent states mean zero, not missing — callers index by state name.
      return Object.fromEntries(states.map((s) => [s, counts[s] ?? 0]))
    },
  })
}

/** An unpaged item list, for pickers and small fixed collections. */
export function itemCollectionQuery<T>(filters: ItemFilters, limit = 1000) {
  return queryOptions({
    queryKey: qk.collection('items', 'all', { ...filters, limit }),
    queryFn: async (): Promise<Array<T>> => {
      const qs = new URLSearchParams({ limit: String(limit) })
      applyItemFilters(qs, filters)
      const result = await apiFetch<{ data: { items: Array<T> } }>(
        `/api/v1/items?${qs}`,
      )
      return result.data.items
    },
  })
}

/**
 * How the version context a detail page is viewing is addressed on the wire.
 * `main` needs no request at all — it is the item the caller already holds.
 */
export interface ItemVersionContext {
  type: string
  commitId?: string | null
  tagId?: string | null
  branchId?: string | null
}

/** The query string for a context, or `null` when there is nothing to ask. */
function contextSearchParams(context: ItemVersionContext): string | null {
  const params = new URLSearchParams()
  if (context.type === 'commit' && context.commitId) {
    params.set('commitId', context.commitId)
  } else if (context.type === 'tag' && context.tagId) {
    params.set('tagId', context.tagId)
  } else if (context.type === 'branch' && context.branchId) {
    params.set('branchId', context.branchId)
  }
  const search = params.toString()
  return search === '' ? null : search
}

/**
 * One item as it stood at a commit, tag, or branch.
 *
 * Returns `null` when the item does not exist at that context, so callers can
 * fall back to the version they already hold. Disabled automatically for a
 * context that addresses nothing — viewing `main` is not a request.
 */
/**
 * Where this item's edit lock lives — the branch working copy, or
 * unprotected main. A null `lockBranchId` with `isMainProtected` means the
 * caller must revise through an ECO or workspace branch instead.
 *
 * Keyed beneath the item, so a checkout or check-in refreshes it through the
 * resource graph rather than each page reloading it by hand.
 */
export function itemEditContextQuery<T>(id: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('items', id, 'edit-context'),
    queryFn: async (): Promise<T | null> => {
      const result = await apiFetch<{ data: { editContext?: T } }>(
        `/api/v1/items/${id}/edit-context`,
      )
      return result.data.editContext ?? null
    },
    enabled: enabled && Boolean(id),
  })
}

/**
 * The branches and tags where this item actually exists.
 *
 * The version picker on a detail page offers only contexts that address the
 * item; the design-wide branch/tag lists answer a different question.
 */
export function itemAvailableContextsQuery<TBranch, TTag>(
  itemId: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('items', itemId, 'available-contexts'),
    queryFn: async (): Promise<{
      branches: Array<TBranch>
      tags: Array<TTag>
    }> => {
      const result = await apiFetch<{
        data: { branches?: Array<TBranch>; tags?: Array<TTag> }
      }>(`/api/v1/items/${itemId}/available-contexts`)
      return {
        branches: result.data.branches ?? [],
        tags: result.data.tags ?? [],
      }
    },
    enabled: enabled && Boolean(itemId),
  })
}

export function itemAtContextQuery<T>(
  itemId: string,
  context: ItemVersionContext,
  enabled = true,
) {
  const search = contextSearchParams(context)

  return queryOptions({
    queryKey: qk.sub('items', itemId, 'at-context', search ?? 'main'),
    queryFn: async (): Promise<T | null> => {
      const result = await apiFetch<{
        data: { item: T | null; existsAtContext: boolean }
      }>(`/api/v1/items/${itemId}/at-context?${search}`)
      return result.data.item
    },
    enabled: enabled && Boolean(itemId) && search !== null,
  })
}

/**
 * One item resolved at a context, with the id the resolution landed on.
 *
 * `itemAtContextQuery`'s sibling for pages that navigate rather than display
 * in place: `PartDetail` swaps routes when the context resolves to a
 * different row (a branch working copy vs its released counterpart), so it
 * needs `resolvedItemId` — and `main` is a real request here
 * (`released=true`) rather than "nothing to ask", because the page may be
 * holding a branch working copy whose main version is another row entirely.
 */
export function itemResolvedAtContextQuery<T>(
  itemId: string,
  context: ItemVersionContext,
  enabled = true,
) {
  const search =
    contextSearchParams(context) ??
    (context.type === 'main' ? 'released=true' : null)

  return queryOptions({
    queryKey: qk.sub('items', itemId, 'resolved-at-context', search ?? 'none'),
    queryFn: async (): Promise<{
      item: T | null
      existsAtContext: boolean
      resolvedItemId?: string
    }> => {
      const result = await apiFetch<{
        data: {
          item: T | null
          existsAtContext: boolean
          resolvedItemId?: string
        }
      }>(`/api/v1/items/${itemId}/at-context?${search}`)
      return result.data
    },
    enabled: enabled && Boolean(itemId) && search !== null,
  })
}
