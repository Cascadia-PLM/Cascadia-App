// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Wire types for the digital thread — the shapes `GET /api/v1/thread/*`
 * returns and the UI renders. Declared here, apart from the services that
 * compute them, so the web package can name them without reaching the
 * server; `ThreadService` and `ThreadComparisonService` re-export them.
 */

import type { OptionCondition } from '../types/variants'
import type { VersionContext } from '../versioning/version-context'

/**
 * Node in the digital thread graph.
 * Design fields are null for design-less operational items (WorkOrder,
 * PhysicalPart) — the physical domain rides the identity layer only.
 */
export interface ThreadNode {
  id: string
  masterId: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  domain: ThreadDomain
  designId: string | null
  designCode: string | null
  designName: string | null
  isFocalItem: boolean
}

/**
 * Edge in the digital thread graph
 */
export interface ThreadEdge {
  id: string
  sourceId: string
  targetId: string
  relationshipType: string
  domain: 'same' | 'cross' // Same domain (BOM) or cross-domain (EBOM_SOURCE)
  quantity: string | null
  derivationMethod: string | null
  /** Product variants: option condition on a BOM line; null when fixed. */
  option?: OptionCondition | null
  /** Execution pinned on a BOM edge's target Part revision. */
  targetMakeCode?: string | null
}

/**
 * Complete digital thread response
 */
export interface ThreadResponse {
  focalItem: ThreadNode
  domains: {
    requirements: Array<ThreadNode>
    engineering: Array<ThreadNode>
    manufacturing: Array<ThreadNode>
    validation: Array<ThreadNode>
    physical: Array<ThreadNode>
  }
  relationships: Array<ThreadEdge>
  stats: {
    totalNodes: number
    totalRelationships: number
    mbomCoverage: number // % of EBOM items with MBOM mapping
    requirementsCoverage: number // % of items with requirements satisfied
    testCoverage: number // % of requirements with test cases
  }
}

/**
 * Domain types for the digital thread
 * - requirements: Requirements domain (traceability)
 * - engineering: Engineering domain (EBOM)
 * - manufacturing: Manufacturing domain (MBOM)
 * - validation: Validation domain (test cases)
 * - physical: Physical domain (work orders, serialized units, lots)
 */
export type ThreadDomain =
  'requirements' | 'engineering' | 'manufacturing' | 'validation' | 'physical'

/**
 * Node diff status in a thread comparison
 */
export type NodeDiffStatus = 'added' | 'removed' | 'modified' | 'unchanged'

/**
 * Edge diff status in a thread comparison
 */
export type EdgeDiffStatus = 'added' | 'removed' | 'modified' | 'unchanged'

/**
 * A single field change in a node
 */
export interface FieldChange {
  fieldName: string
  fieldPath?: string
  oldValue: unknown
  newValue: unknown
  fieldCategory: 'core' | 'type' | 'attribute' | 'relationship'
}

/**
 * A thread node with diff information
 */
export interface ThreadNodeDiff {
  node: ThreadNode
  status: NodeDiffStatus
  previousNode?: ThreadNode
  fieldChanges: Array<FieldChange>
  sourceContext: 'before' | 'after' | 'both'
}

/**
 * A thread edge with diff information
 */
export interface ThreadEdgeDiff {
  edge: ThreadEdge
  status: EdgeDiffStatus
  previousEdge?: ThreadEdge
  changes?: {
    quantityChanged?: boolean
    derivationMethodChanged?: boolean
    optionChanged?: boolean
    targetMakeChanged?: boolean
  }
  sourceContext: 'before' | 'after' | 'both'
}

/**
 * Enriched version context info for display
 */
export interface VersionContextInfo {
  context: VersionContext
  label: string // "v1.0.0", "ECO-2024-001", "Released (main)"
  timestamp?: Date
  commitMessage?: string
}

/**
 * Statistics for a thread comparison
 */
export interface ThreadComparisonStats {
  nodesAdded: number
  nodesRemoved: number
  nodesModified: number
  nodesUnchanged: number
  totalNodes: number
  changesByDomain: Record<
    ThreadDomain,
    { added: number; removed: number; modified: number }
  >
  relationshipsAdded: number
  relationshipsRemoved: number
  relationshipsModified: number
  totalFieldChanges: number
  coverageChanges: {
    mbomCoverage: { before: number; after: number }
    requirementsCoverage: { before: number; after: number }
    testCoverage: { before: number; after: number }
  }
}

/**
 * Complete thread comparison result
 */
export interface ThreadComparison {
  beforeContext: VersionContextInfo
  afterContext: VersionContextInfo
  focalItem: ThreadNodeDiff
  domains: {
    requirements: Array<ThreadNodeDiff>
    engineering: Array<ThreadNodeDiff>
    manufacturing: Array<ThreadNodeDiff>
    validation: Array<ThreadNodeDiff>
    /** Always empty: physical reality is context-independent, so version
     * comparisons have nothing physical to diff. Present for shape parity. */
    physical: Array<ThreadNodeDiff>
  }
  relationships: Array<ThreadEdgeDiff>
  stats: ThreadComparisonStats
  comparedAt: Date
}

/**
 * Available comparison targets for a design
 */
export interface ComparisonTargets {
  tags: Array<{
    id: string
    name: string
    tagType: string | null
    createdAt: Date
  }>
  branches: Array<{
    id: string
    name: string
    branchType: string
    isLocked: boolean
    isArchived: boolean
  }>
  recentCommits: Array<{
    id: string
    message: string
    createdAt: Date
  }>
}
