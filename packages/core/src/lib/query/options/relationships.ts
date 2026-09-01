// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { BOMTreeNode } from '@/components/bom/types'
import { apiFetch } from '@/lib/api/client'

/**
 * Reads over an item's relationship edges — the flat list, the BOM tree it
 * spans, the assemblies it appears in, and the neighbourhood graph.
 *
 * All four are keyed beneath the item they hang off, so `invalidate('relationships')`
 * — which fans out to `items` — refreshes them together. They used to live in
 * component state behind effects, which is why adding a BOM edge left the
 * graph, the tree and the where-used tab showing the pre-edit structure.
 */

/** Which slice of an item's edges to read, and in which branch context. */
export interface ItemRelationshipContext {
  /** Restrict to one relationship type, e.g. `BOM`. */
  type?: string
  /** Resolve targets in a branch rather than on main. */
  branchId?: string
}

function relationshipSearch(context: ItemRelationshipContext): string {
  const search = new URLSearchParams()
  if (context.type) search.set('type', context.type)
  if (context.branchId) search.set('branch', context.branchId)
  return search.size > 0 ? `?${search}` : ''
}

/**
 * Outgoing relationships from an item, with their target items resolved.
 *
 * Generic in the row type so a caller that needs concrete columns can name
 * them rather than re-narrowing at every use site.
 */
export function itemRelationshipsQuery<T>(
  itemId: string,
  context: ItemRelationshipContext = {},
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('items', itemId, 'relationships', {
      type: context.type,
      branchId: context.branchId,
    }),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{
        data: { relationships?: Array<T> }
      }>(`/api/v1/items/${itemId}/relationships${relationshipSearch(context)}`)
      return result.data.relationships ?? []
    },
    enabled: enabled && Boolean(itemId),
  })
}

/** The assemblies an item is consumed by, walked upward. */
export function itemWhereUsedQuery<T>(itemId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('items', itemId, 'where-used'),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: { whereUsed?: Array<T> } }>(
        `/api/v1/items/${itemId}/where-used`,
      )
      return result.data.whereUsed ?? []
    },
    enabled: enabled && Boolean(itemId),
  })
}

export type ItemGraphDirection = 'all' | 'outgoing' | 'incoming'

/** Raw React Flow input, before layout. */
export interface ItemGraph {
  nodes: Array<any>
  edges: Array<any>
}

export interface ItemGraphParams {
  depth?: number
  direction?: ItemGraphDirection
  /** Empty means every type. */
  types?: Array<string>
  /** Branch context, used for file visibility only. */
  branchId?: string
  includeFiles?: boolean
  /**
   * Whether definition/usage edges come back. Omitted leaves the server's own
   * default in place — which is that they do — so a caller predating this
   * param sends exactly the request it sent before; only a caller with an
   * opinion states one.
   */
  includeUsages?: boolean
}

/**
 * The relationship neighbourhood around an item.
 *
 * Unlike every other endpoint here, `/graph` answers with `{ nodes, edges }`
 * at the top level rather than inside a `data` envelope.
 */
export function itemGraphQuery(
  itemId: string,
  params: ItemGraphParams = {},
  enabled = true,
) {
  const {
    depth = 2,
    direction = 'all',
    types = [],
    branchId,
    includeFiles = false,
    includeUsages,
  } = params

  const search = new URLSearchParams({ depth: String(depth), direction })
  if (includeFiles) search.set('includeFiles', 'true')
  if (includeUsages !== undefined) {
    search.set('includeUsages', String(includeUsages))
  }
  if (types.length > 0) search.set('types', types.join(','))
  if (branchId) search.set('branch', branchId)

  return queryOptions({
    queryKey: qk.sub('items', itemId, 'graph', {
      depth,
      direction,
      types,
      branchId,
      includeFiles,
      includeUsages,
    }),
    queryFn: (): Promise<ItemGraph> =>
      apiFetch<ItemGraph>(`/api/v1/items/${itemId}/graph?${search}`),
    enabled: enabled && Boolean(itemId),
  })
}

/** The subset of an item record the BOM tree renders. */
interface BomItem {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  designId: string | null
}

interface BomRelationship {
  id: string
  relationshipType: string
  quantity: string | null
  findNumber: number | null
  targetItem: BomItem
}

/**
 * The BOM hierarchy rooted at an item, assembled by walking `BOM` edges.
 *
 * One request per node, so it is deliberately keyed and cached rather than
 * rebuilt on every tab switch. Branches of the walk that revisit an ancestor
 * stop there, so a cyclic structure terminates.
 */
/**
 * What this item's digital thread can be compared against.
 *
 * Keyed beneath the item, so a relationship or version change refreshes the
 * picker rather than leaving the dialog with a stale list.
 */
export function threadComparisonTargetsQuery<T>(
  itemId: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('items', itemId, 'thread-comparison-targets'),
    queryFn: async (): Promise<T> => {
      const result = await apiFetch<{ data: T }>(
        `/api/v1/thread/${itemId}/comparison-targets`,
      )
      return result.data
    },
    enabled: enabled && Boolean(itemId),
  })
}

export function itemBomTreeQuery(
  itemId: string,
  branchId?: string,
  enabled = true,
) {
  const branchParam = branchId ? `&branch=${branchId}` : ''

  const buildTreeNode = async (
    id: string,
    itemData: BomItem,
    visited: Set<string>,
  ): Promise<BOMTreeNode> => {
    const node: BOMTreeNode = {
      itemId: id,
      itemNumber: itemData.itemNumber,
      name: itemData.name ?? '',
      revision: itemData.revision,
      state: itemData.state,
      itemType: itemData.itemType,
      designId: itemData.designId,
    }

    if (visited.has(id)) {
      return { ...node, children: [] }
    }
    visited.add(id)

    const result = await apiFetch<{
      data: { relationships?: Array<BomRelationship> }
    }>(`/api/v1/items/${id}/relationships?type=BOM${branchParam}`)

    const bomRelationships = (result.data.relationships ?? []).filter(
      (rel) => rel.relationshipType === 'BOM',
    )

    const children = await Promise.all(
      bomRelationships.map(async (rel) => {
        const child = await buildTreeNode(
          rel.targetItem.id,
          rel.targetItem,
          new Set(visited),
        )
        return {
          ...child,
          quantity: rel.quantity ? parseFloat(rel.quantity) : undefined,
          findNumber: rel.findNumber ?? undefined,
          relationshipId: rel.id,
        }
      }),
    )

    return { ...node, children: children.length > 0 ? children : undefined }
  }

  return queryOptions({
    queryKey: qk.sub('items', itemId, 'bom-tree', { branchId }),
    queryFn: async (): Promise<Array<BOMTreeNode>> => {
      const result = await apiFetch<{ data: { item: BomItem } }>(
        `/api/v1/items/${itemId}`,
      )
      return [await buildTreeNode(itemId, result.data.item, new Set())]
    },
    enabled: enabled && Boolean(itemId),
  })
}

/** Depth budget and domain slice for one digital-thread read. */
export interface ItemThreadParams {
  upstreamDepth?: number
  downstreamDepth?: number
  bomDepth?: number
  /** Empty means the server's own default domain set. */
  domains?: Array<string>
}

/**
 * The cross-domain digital thread around an item.
 *
 * Generic in the response so the query layer does not have to name the thread
 * service's shapes. Keyed beneath the item like the comparison targets above,
 * so a relationship or version write refreshes a mounted thread view, and
 * keyed by the depth budget so moving a depth control re-keys rather than
 * re-invoking a loader.
 */
export function itemThreadQuery<T>(
  itemId: string,
  params: ItemThreadParams = {},
  enabled = true,
) {
  const {
    upstreamDepth = 5,
    downstreamDepth = 5,
    bomDepth = 3,
    domains = [],
  } = params

  const search = new URLSearchParams({
    upstreamDepth: String(upstreamDepth),
    downstreamDepth: String(downstreamDepth),
    bomDepth: String(bomDepth),
  })
  if (domains.length > 0) search.set('domains', domains.join(','))

  return queryOptions({
    queryKey: qk.sub('items', itemId, 'thread', {
      upstreamDepth,
      downstreamDepth,
      bomDepth,
      domains,
    }),
    queryFn: async (): Promise<T> => {
      const result = await apiFetch<{ data: T }>(
        `/api/v1/thread/${itemId}?${search}`,
      )
      return result.data
    },
    enabled: enabled && Boolean(itemId),
  })
}
