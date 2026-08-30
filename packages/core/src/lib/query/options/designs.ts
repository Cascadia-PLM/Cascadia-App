// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { gridParamsToSearchParams } from '../grid-params'
import { entityQuery } from './entities'
import type { GridParams, GridQuery } from '../grid-params'
import type { Design } from '@/lib/types/design'
import { apiFetch } from '@/lib/api/client'

/**
 * Designs, optionally scoped to a program.
 *
 * Nine routes load this list (as a picker, a sidebar, or the list page
 * itself). Sharing one factory means they share one cache entry and one
 * fetch, and all nine refresh together when a design is created.
 */
export function designListQuery<T = Design>(programId?: string) {
  return queryOptions({
    queryKey: qk.list('designs', programId ? { programId } : {}),
    queryFn: async (): Promise<Array<T>> => {
      const qs = new URLSearchParams()
      if (programId) qs.set('programId', programId)
      const suffix = qs.size > 0 ? `?${qs}` : ''
      const result = await apiFetch<{ data: { designs: Array<T> } }>(
        `/api/v1/designs${suffix}`,
      )
      return result.data.designs
    },
  })
}

export interface DesignCounts {
  design: number
  family: number
  library: number
}

const EMPTY_DESIGN_COUNTS: DesignCounts = { design: 0, family: 0, library: 0 }

/**
 * The paged designs grid.
 *
 * `/api/v1/designs` supports `limit`/`offset`/`sortField`/`columnFilters`
 * server-side; the previous grid sent none of them, fetched every row, and
 * reported the page length as the total.
 */
export function designGridQuery(
  grid: GridParams,
  programId?: string,
): GridQuery<Design> {
  return {
    queryKey: qk.list('designs', { ...grid, programId }),
    queryFn: async () => {
      const qs = gridParamsToSearchParams(grid)
      if (programId) qs.set('programId', programId)
      const result = await apiFetch<{
        data: { designs: Array<Design>; total: number }
      }>(`/api/v1/designs?${qs}`)
      return { items: result.data.designs, total: result.data.total }
    },
  }
}

/** Design counts by type, in one request rather than three. */
export function designCountsQuery(programId?: string) {
  return queryOptions({
    queryKey: qk.collection(
      'designs',
      'counts',
      programId ? { programId } : {},
    ),
    queryFn: async (): Promise<DesignCounts> => {
      const qs = new URLSearchParams({ limit: '1', includeCounts: 'true' })
      if (programId) qs.set('programId', programId)
      const result = await apiFetch<{ data: { counts?: DesignCounts } }>(
        `/api/v1/designs?${qs}`,
      )
      return result.data.counts ?? EMPTY_DESIGN_COUNTS
    },
  })
}

export function designDetailQuery(id: string, enabled = true) {
  return entityQuery<Design>('designs', id, 'design', enabled)
}

export interface DesignBranch {
  id: string
  name: string
  [key: string]: unknown
}

export interface DesignTag {
  id: string
  name: string
  [key: string]: unknown
}

/**
 * Branches on a design.
 *
 * Generic in the row type so a caller that needs concrete columns (the page
 * header, the branch selector, the baselines tab) can name them instead of
 * re-narrowing the index-signature default at every use site.
 */
/** One row of `/api/v1/designs/:id/ecos`. */
export interface DesignEco {
  id: string
  itemNumber: string
  name: string
  state: string
  reasonForChange: string
  itemCount: number
  owner: { id: string; name: string }
  createdAt: string
  submittedAt?: string
  releasedAt?: string
}

/**
 * The change orders touching one design.
 *
 * Read unfiltered and narrowed in the browser: the endpoint's `status`
 * parameter is the same `state === status` predicate the tab already applies,
 * so keying on it would buy nothing and cost a request per filter change.
 *
 * Keyed beneath the design, so releasing an ECO refreshes the list.
 */
export function designEcosQuery(designId: string) {
  return queryOptions({
    queryKey: qk.sub('designs', designId, 'ecos'),
    queryFn: async (): Promise<Array<DesignEco>> => {
      const result = await apiFetch<{ data: { ecos: Array<DesignEco> } }>(
        `/api/v1/designs/${designId}/ecos`,
      )
      return result.data.ecos
    },
    enabled: Boolean(designId),
  })
}

/**
 * The three scalar fields of a `VersionContext` that change what
 * `/designs/:id/structure` returns.
 *
 * Deliberately not the `VersionContext` object itself. The read this replaced
 * lived in a `useEffect` whose dependency was that object, and
 * `useVersionContext` rebuilds it whenever the page's URL search changes —
 * which on the design detail page includes the tab, the Items grid's page,
 * sort and every column filter. Switching tabs re-fetched the whole BOM tree
 * because the object was new, not because the version was. Naming the three
 * scalars makes the key change exactly when the server's answer would.
 */
export interface DesignStructureContext {
  branchId?: string
  tagId?: string
  commitId?: string
}

/**
 * One design's BOM tree plus the items that belong to it but sit outside the
 * hierarchy.
 *
 * Generic in the node and orphan row types for the same reason
 * `ecoDesignStructureQuery` is: the concrete shapes are component types
 * (`BOMTreeNode` and the structure tab's non-structure row), and the query
 * layer has no business importing from `components/`.
 */
export interface DesignStructure<TNode, TOrphan> {
  roots: Array<TNode>
  orphans: Array<TOrphan>
}

/**
 * The design structure at a version context.
 *
 * Keyed beneath the design, so a write that names `designs` — or `relationships`,
 * which reaches `designs` through `RESOURCE_DEPENDENTS` — refreshes the tree
 * wherever it is mounted. Each version context gets its own cache entry, so
 * switching to a baseline and back does not re-fetch what is already held.
 */
export function designStructureQuery<TNode, TOrphan>(
  designId: string,
  context: DesignStructureContext = {},
) {
  const { branchId, tagId, commitId } = context
  return queryOptions({
    queryKey: qk.sub('designs', designId, 'structure', {
      branchId,
      tagId,
      commitId,
    }),
    queryFn: async (): Promise<DesignStructure<TNode, TOrphan>> => {
      const qs = new URLSearchParams()
      if (branchId) qs.set('branch', branchId)
      if (tagId) qs.set('tag', tagId)
      if (commitId) qs.set('commit', commitId)
      const suffix = qs.size > 0 ? `?${qs}` : ''
      const result = await apiFetch<{
        data: DesignStructure<TNode, TOrphan>
      }>(`/api/v1/designs/${designId}/structure${suffix}`)
      return { roots: result.data.roots, orphans: result.data.orphans }
    },
    enabled: Boolean(designId),
  })
}

export function designBranchesQuery<T = DesignBranch>(
  id: string,
  includeArchived = true,
  enabled = true,
) {
  const search = includeArchived ? 'includeArchived=true' : ''
  return queryOptions({
    queryKey: qk.sub('designs', id, 'branches', search || undefined),
    queryFn: async (): Promise<Array<T>> => {
      const suffix = search ? `?${search}` : ''
      const result = await apiFetch<{ data: { branches: Array<T> } }>(
        `/api/v1/designs/${id}/branches${suffix}`,
      )
      return result.data.branches
    },
    enabled: enabled && Boolean(id),
  })
}

/** Baseline tags on a design. Generic for the same reason as branches. */
export function designTagsQuery<T = DesignTag>(id: string) {
  return queryOptions({
    queryKey: qk.sub('designs', id, 'tags'),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: { tags: Array<T> } }>(
        `/api/v1/designs/${id}/tags`,
      )
      return result.data.tags
    },
  })
}

export interface DesignFamily {
  id: string
  code: string
  name: string
}

/** Family designs available as a parent, scoped to a program. */
/**
 * The requirements-coverage gap analysis for one design.
 *
 * Keyed beneath the design, so releasing or editing items refreshes the
 * widget through the resource graph.
 */
export function designGapAnalysisQuery<T>(designId: string) {
  return queryOptions({
    queryKey: qk.sub('designs', designId, 'gap-analysis'),
    queryFn: async (): Promise<T> => {
      const result = await apiFetch<{ data: T }>(
        `/api/v1/designs/${designId}/gap-analysis`,
      )
      return result.data
    },
  })
}

/**
 * The commit graph for one design, optionally narrowed to a branch.
 *
 * Keyed beneath the design so a commit or merge refreshes it.
 */
export function designHistoryGraphQuery<T>(
  designId: string,
  branchId?: string,
  limit = 50,
) {
  return queryOptions({
    queryKey: qk.sub('designs', designId, 'history-graph', { branchId, limit }),
    queryFn: async (): Promise<T> => {
      const qs = new URLSearchParams({ limit: String(limit) })
      if (branchId) qs.set('branchId', branchId)
      const result = await apiFetch<{ data: T }>(
        `/api/v1/designs/${designId}/history/graph?${qs}`,
      )
      return result.data
    },
  })
}

export function designFamiliesQuery(programId?: string) {
  return queryOptions({
    queryKey: qk.collection(
      'designs',
      'families',
      programId ? { programId } : {},
    ),
    queryFn: async (): Promise<Array<DesignFamily>> => {
      const qs = new URLSearchParams()
      if (programId) qs.set('programId', programId)
      const suffix = qs.size > 0 ? `?${qs}` : ''
      const result = await apiFetch<{
        data: { families: Array<DesignFamily> }
      }>(`/api/v1/designs/families${suffix}`)
      return result.data.families
    },
  })
}
