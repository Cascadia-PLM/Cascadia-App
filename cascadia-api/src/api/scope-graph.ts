// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

/**
 * Shared builders for the Program/Design scope graph endpoints
 * (GET /api/v1/programs/:id/graph and GET /api/v1/designs/:id/graph).
 *
 * The scope graph mixes three node kinds — Program, Design, and Item — so
 * Program and Design nodes get prefixed IDs (`program:<uuid>`, `design:<uuid>`)
 * while Item nodes keep their raw item row ID. Item nodes reuse the exact data
 * shape of GET /api/v1/items/:id/graph so the client can merge results from
 * both endpoints into one graph and render them with the same node component.
 */

/** Synthetic relationship type for program→design and design→item edges. */
export const SCOPE_CONTAINS = 'Contains'

export type ScopeNodeKind = 'program' | 'design'

export interface ScopeGraphNode {
  id: string
  type: 'scopeNode' | 'itemNode'
  data: Record<string, unknown>
  position: { x: number; y: number }
}

export interface ScopeGraphEdge {
  id: string
  source: string
  target: string
  label: string
  data: {
    relationshipType: string
    /** Marks program→design / design→item containment edges. */
    isScopeRelationship: boolean
  }
}

export interface ScopeItemTypeCount {
  itemType: string
  count: number
}

export function programNodeId(programId: string): string {
  return `program:${programId}`
}

export function designNodeId(designId: string): string {
  return `design:${designId}`
}

export function makeProgramNode(
  program: { id: string; code: string; name: string; status: string },
  level: number,
): ScopeGraphNode {
  return {
    id: programNodeId(program.id),
    type: 'scopeNode',
    data: {
      kind: 'program' satisfies ScopeNodeKind,
      entityId: program.id,
      code: program.code,
      name: program.name,
      subtype: program.status,
      level,
    },
    position: { x: 0, y: 0 },
  }
}

export function makeDesignNode(
  design: { id: string; code: string; name: string; designType: string },
  level: number,
): ScopeGraphNode {
  return {
    id: designNodeId(design.id),
    type: 'scopeNode',
    data: {
      kind: 'design' satisfies ScopeNodeKind,
      entityId: design.id,
      code: design.code,
      name: design.name,
      subtype: design.designType,
      level,
    },
    position: { x: 0, y: 0 },
  }
}

export function makeScopeItemNode(
  item: {
    id: string
    itemNumber: string
    revision: string
    itemType: string
    name: string | null
    state: string
  },
  level: number,
): ScopeGraphNode {
  // Same data shape GET /api/v1/items/:id/graph produces, so the client can
  // expand these nodes through the item graph endpoint and merge the results.
  return {
    id: item.id,
    type: 'itemNode',
    data: {
      itemId: item.id,
      itemNumber: item.itemNumber,
      revision: item.revision,
      itemType: item.itemType,
      name: item.name ?? '',
      state: item.state,
      level,
      isDefinition: false,
      isUsage: false,
    },
    position: { x: 0, y: 0 },
  }
}

export function makeScopeEdge(
  sourceNodeId: string,
  targetNodeId: string,
): ScopeGraphEdge {
  return {
    id: `${sourceNodeId}->${targetNodeId}`,
    source: sourceNodeId,
    target: targetNodeId,
    label: 'contains',
    data: {
      relationshipType: SCOPE_CONTAINS,
      isScopeRelationship: true,
    },
  }
}

export const scopeGraphQuerySchema = z.object({
  direction: z.enum(['all', 'up', 'down']).optional().default('all'),
  /** Comma-separated item types; empty/absent means all types. */
  itemTypes: z.string().optional(),
})

export const scopeGraphResponseSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      data: z.record(z.string(), z.unknown()),
      position: z.object({ x: z.number(), y: z.number() }),
    }),
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      target: z.string(),
      label: z.string(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  availableItemTypes: z.array(
    z.object({ itemType: z.string(), count: z.number() }),
  ),
})
