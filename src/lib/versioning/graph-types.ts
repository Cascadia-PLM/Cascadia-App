import type { Edge, Node } from '@xyflow/react'

/**
 * Types for commit graph visualization
 */

export interface CommitNodeData extends Record<string, unknown> {
  commitId: string
  message: string
  author: { id: string; name: string }
  date: string
  branchId: string
  branchName: string
  branchType: 'main' | 'eco' | 'workspace' | 'release'
  isMergeCommit: boolean
  changeStats?: { added: number; modified: number; deleted: number }
  tags?: Array<{ id: string; name: string; tagType: string }>
  /** Link to ECO item for release commits */
  changeOrderItemId?: string
  /** ECO item number for display (e.g., "ECO-000001") */
  ecoNumber?: string
  revisionsAssigned?: Record<string, string>
  onViewCommit?: (commitId: string) => void

  /** Consolidation fields - present when multiple commits are grouped */
  isConsolidated?: boolean
  /** Number of commits consolidated into this node */
  consolidatedCount?: number
  /** IDs of all commits consolidated into this node */
  consolidatedCommitIds?: Array<string>
  /** Date range for consolidated commits (earliest date) */
  dateRangeStart?: string
  /** Date range for consolidated commits (latest date) */
  dateRangeEnd?: string
}

export type CommitGraphNode = Node<CommitNodeData, 'commitNode'>

export interface CommitEdgeData extends Record<string, unknown> {
  edgeType: 'parent' | 'merge'
}

export type CommitGraphEdge = Edge<CommitEdgeData>

export interface CommitGraphData {
  nodes: Array<CommitGraphNode>
  edges: Array<CommitGraphEdge>
  forkPoint?: string
  mainBranchId: string
  selectedBranchId?: string
  selectedBranchName?: string
}

/**
 * API response type for /api/designs/:id/history/graph
 */
export interface CommitGraphResponse {
  data: CommitGraphData
}

// ============================================================================
// Program-Level Graph Types
// ============================================================================

/**
 * Extended node data for program-level view
 * Includes design context for cross-design visualization
 */
export interface ProgramCommitNodeData extends CommitNodeData {
  /** Design this commit belongs to */
  designId: string
  designCode: string
  designName: string
}

export type ProgramCommitGraphNode = Node<ProgramCommitNodeData, 'commitNode'>

/**
 * Edge data for cross-design ECO connections
 */
export interface EcoConnectorEdgeData extends Record<string, unknown> {
  edgeType: 'eco-connector'
  ecoId: string
  ecoNumber: string
  /** Source design info */
  sourceDesignId: string
  sourceDesignCode: string
  /** Target design info */
  targetDesignId: string
  targetDesignCode: string
}

export type EcoConnectorEdge = Edge<EcoConnectorEdgeData>

/**
 * Design info for program graph
 */
export interface ProgramGraphDesign {
  id: string
  code: string
  name: string
  mainBranchId: string
  /** Assigned during layout */
  columnIndex?: number
}

/**
 * Cross-design ECO info
 */
export interface CrossDesignEco {
  id: string
  ecoNumber: string
  ecoName: string
  affectedDesigns: Array<{
    designId: string
    designCode: string
    branchId: string | null
    branchName: string | null
  }>
}

/**
 * Data structure for program-level history graph
 */
export interface ProgramGraphData {
  /** All commit nodes across all designs */
  nodes: Array<ProgramCommitGraphNode>
  /** Parent/merge edges within designs */
  edges: Array<CommitGraphEdge>
  /** Cross-design ECO connector edges */
  ecoConnectorEdges: Array<EcoConnectorEdge>
  /** Design metadata for layout and headers */
  designs: Array<ProgramGraphDesign>
  /** ECOs that span multiple designs */
  crossDesignEcos: Array<CrossDesignEco>
  /** Program metadata */
  program: {
    id: string
    code: string
    name: string
  }
}

/**
 * API response type for /api/programs/:id/history/graph
 */
export interface ProgramGraphResponse {
  data: ProgramGraphData
}
