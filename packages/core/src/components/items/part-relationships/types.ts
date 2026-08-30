// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Shapes shared by the relationships panel and its four views.
 *
 * The graph cache types are here rather than beside the graph because the
 * container owns those caches — see `useRelationshipGraph` for why they
 * cannot live in the view that reads them.
 */

export interface Relationship {
  id: string
  sourceId: string
  targetId: string
  relationshipType: string
  quantity: string | null
  referenceDesignator: string | null
  findNumber: number | null
  targetItem: {
    id: string
    itemNumber: string
    revision: string
    itemType: string
    name: string
    state: string
  }
}

/** The fields of the centre item that decide whether `UsageOf` is in play. */
export interface ItemUsageInfo {
  usageOf?: string | null
  usageCount?: number | null
}

export interface WhereUsedNode {
  itemId: string
  itemNumber: string
  revision: string
  name: string
  itemType: string
  state: string
  depth: number
  designName?: string | null
}

export type ViewMode = 'graph' | 'table' | 'bom' | 'where-used'
export type DirectionMode = 'all' | 'outgoing' | 'incoming'

// --- Graph cache types ---
export interface CachedNode {
  id: string
  type: string
  data: any
  position: { x: number; y: number }
}
export interface CachedEdge {
  id: string
  source: string
  target: string
  label?: string
  type: string
  animated?: boolean
  markerEnd?: any
  style?: any
  data: any
}
export interface ExpandState {
  upstream: boolean
  downstream: boolean
}
export interface FetchedState {
  upstream: boolean
  downstream: boolean
}
