// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The system architecture of one design as it crosses the wire: the
 * `DECOMPOSES` tree of its system elements at a version context, each element
 * with the items that realize it and the requirements allocated to it, plus
 * the `CONNECTS` edges between elements and the saved block positions the
 * block diagram draws them at.
 *
 * Read by `GET /api/v1/designs/:id/architecture` and rendered by the design
 * page's Architecture tab, as a tree and as a graph. Links reuse the
 * requirements matrix's link shape so the two surfaces read the same way:
 * an end resolved to its row at the context, with its suspect state.
 */
import type { RtmContext, RtmLink } from './requirements-matrix'

/** One end of an architecture edge, resolved to its row at the context. */
export type ArchitectureLink = RtmLink

export interface ArchitectureNode {
  itemId: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  elementKind: string | null
  description: string | null
  /** The `DECOMPOSES` edge joining this node to its parent; absent on roots. */
  relationshipId?: string
  /** The items (parts, software) that realize this element — `REALIZED_BY`. */
  realizedBy: Array<ArchitectureLink>
  /** The requirements allocated to this element — incoming `ALLOCATED_TO`. */
  allocatedRequirements: Array<ArchitectureLink>
  children: Array<ArchitectureNode>
}

/**
 * A `CONNECTS` edge between two elements of the design, both ends resolved
 * to their rows at the context — a line in the block diagram.
 */
export interface ArchitectureConnection {
  relationshipId: string
  /** The element the connection is stated on (`itemId` of a node). */
  sourceItemId: string
  /** The element it runs to (`itemId` of a node). */
  targetItemId: string
  name: string | null
  /** One of the system connection kinds, or null when none was chosen. */
  kind: string | null
}

/** Where a block sits in the diagram, relative to the block it is inside. */
export interface ArchitectureBlockPosition {
  x: number
  y: number
}

/**
 * The saved block positions of a design's diagram, by element master id.
 * Presentation, not engineering data: one layout per design, shared by every
 * version context, unversioned and not part of any change order.
 */
export type ArchitectureLayout = Record<string, ArchitectureBlockPosition>

export interface ArchitectureTotals {
  /** Elements at the context. */
  elements: number
  /** Elements with at least one realizing item. */
  realized: number
  /** Elements with at least one allocated requirement. */
  allocated: number
  /** Architecture links (`REALIZED_BY`, `ALLOCATED_TO`) that are suspect. */
  suspect: number
}

export interface DesignArchitecture {
  designId: string
  designCode: string
  designName: string
  context: RtmContext
  /** Elements no other element decomposes into, with their subtrees. */
  roots: Array<ArchitectureNode>
  /** The `CONNECTS` edges between elements present at the context. */
  connections: Array<ArchitectureConnection>
  /** Saved block positions; an element absent from it is placed automatically. */
  layout: ArchitectureLayout
  totals: ArchitectureTotals
}
