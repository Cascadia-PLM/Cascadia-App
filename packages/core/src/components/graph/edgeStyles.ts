// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { MarkerType } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'

/**
 * Shared edge presentation for the relationship graphs — the item graph on a
 * Part/Document, and the scope graph on a Design or Program.
 *
 * Every edge in those views is directed: `source` is the item the
 * relationship is stated on, `target` is the item it points at. A Part with a
 * `Satisfies` relationship to a Requirement is `source: part`,
 * `target: requirement`, and must read that way on screen — "the Part
 * satisfies the Requirement", never the other way around.
 *
 * These helpers make that direction legible:
 *
 * - a filled arrowhead at the target end, in the edge's own colour (React
 *   Flow's `defaultMarkerColor` is a fixed `#b1b1b7` that tracks neither the
 *   stroke nor the colour mode, so every edge sets its marker explicitly);
 * - an arrow inside the label chip pointing the same way as the line, so the
 *   relationship name and its direction are read together (`RelationshipEdge`);
 * - a plain-language tooltip on that chip — "PRT-001 Satisfies REQ-002".
 */

export type GraphEdgeKind =
  'relationship' | 'usage' | 'physical' | 'file' | 'scope'

/**
 * Edge colours, picked to stay legible against both the light (`bg-slate-50`)
 * and dark (`bg-slate-950`) graph canvases. Containment sits one step lighter
 * than relationships so the organizational scaffolding recedes behind the
 * engineering data drawn on top of it.
 */
export const GRAPH_EDGE_COLORS: Record<GraphEdgeKind, string> = {
  relationship: '#64748b', // slate-500
  usage: '#a855f7', // purple-500
  physical: '#10b981', // emerald-500
  file: '#0ea5e9', // sky-500
  scope: '#94a3b8', // slate-400
}

/** Dash pattern per kind. Plain relationships are solid. */
const GRAPH_EDGE_DASH: Partial<Record<GraphEdgeKind, string>> = {
  usage: '5,5',
  physical: '5,5',
  file: '3,3',
}

/**
 * Classify an edge from the flags the graph endpoints put on `edge.data`
 * (`isUsageRelationship`, `isPhysicalRelationship`, `isFileRelationship`,
 * `isScopeRelationship`). Anything unflagged is a plain item relationship.
 */
export function graphEdgeKind(data: Record<string, unknown>): GraphEdgeKind {
  if (data.isUsageRelationship === true) return 'usage'
  if (data.isPhysicalRelationship === true) return 'physical'
  if (data.isFileRelationship === true) return 'file'
  if (data.isScopeRelationship === true) return 'scope'
  return 'relationship'
}

/** Arrowhead drawn at the target end of an edge. */
export function directionalMarker(color: string): Edge['markerEnd'] {
  return { type: MarkerType.ArrowClosed, width: 22, height: 22, color }
}

export interface GraphEdgeVisuals {
  color: string
  markerEnd: Edge['markerEnd']
  style: Edge['style']
}

/**
 * Stroke and arrowhead for one kind of edge. No label style: the views that
 * use this render labels through `RelationshipEdge`'s HTML chip, which takes
 * its colour from the same `is*Relationship` flags.
 */
export function graphEdgeVisuals(kind: GraphEdgeKind): GraphEdgeVisuals {
  const color = GRAPH_EDGE_COLORS[kind]
  return {
    color,
    markerEnd: directionalMarker(color),
    style: {
      stroke: color,
      strokeWidth: 1.5,
      strokeDasharray: GRAPH_EDGE_DASH[kind],
    },
  }
}

/**
 * `UsageOf` edges arrive from the API as usage → definition. Every graph view
 * flips them so a definition sits above its usages, which means the label has
 * to flip too: "usage of" would then read backwards against the arrow, while
 * "used by" reads correctly as "definition used by usage".
 */
export const USAGE_EDGE_LABEL = 'used by'

/** Display name of a graph node: items by number, scopes by code, files by name. */
function nodeDisplayLabel(data: Record<string, unknown>): string | undefined {
  for (const key of ['itemNumber', 'code', 'fileName'] as const) {
    const value = data[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Attach `directionSentence` to every edge whose endpoints are both on
 * screen — "PRT-001 Satisfies REQ-002", read in the direction the arrow
 * points. `RelationshipEdge` surfaces it as the label chip's tooltip.
 *
 * Runs against the laid-out node set rather than a single API response, so
 * edges that span two separately-fetched expansions still get named.
 */
export function withEdgeDirectionLabels(
  nodes: Array<Node>,
  edges: Array<Edge>,
): Array<Edge> {
  const labels = new Map<string, string>()
  for (const node of nodes) {
    const label = nodeDisplayLabel(node.data)
    if (label) labels.set(node.id, label)
  }

  return edges.map((edge) => {
    const source = labels.get(edge.source)
    const target = labels.get(edge.target)
    if (!source || !target) return edge

    const name = typeof edge.label === 'string' ? edge.label : null
    return {
      ...edge,
      data: {
        ...edge.data,
        directionSentence: name
          ? `${source} ${name} ${target}`
          : `${source} → ${target}`,
      },
    }
  })
}

/** Horizontal spread between edges that share a node pair. */
const PARALLEL_EDGE_STEP = 50

/**
 * Sideways offsets for edges that connect the same two nodes, so their labels
 * (and the direction arrows inside them) do not stack on top of each other.
 * Edges with no sibling are absent from the map.
 */
export function parallelEdgeOffsets(
  edges: Array<{ id: string; source: string; target: string }>,
): Map<string, number> {
  const pairs = new Map<string, Array<string>>()
  for (const edge of edges) {
    const key = [edge.source, edge.target].sort().join('|')
    const group = pairs.get(key)
    if (group) {
      group.push(edge.id)
    } else {
      pairs.set(key, [edge.id])
    }
  }

  const offsets = new Map<string, number>()
  for (const [, edgeIds] of pairs) {
    if (edgeIds.length <= 1) continue
    const totalWidth = (edgeIds.length - 1) * PARALLEL_EDGE_STEP
    edgeIds.forEach((edgeId, index) => {
      offsets.set(edgeId, -totalWidth / 2 + index * PARALLEL_EDGE_STEP)
    })
  }

  return offsets
}
