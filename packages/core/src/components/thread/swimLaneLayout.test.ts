// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import {
  THREAD_HANDLE_SOURCE,
  THREAD_HANDLE_SOURCE_ALT,
  THREAD_HANDLE_TARGET,
  THREAD_HANDLE_TARGET_ALT,
  buildThreadAdjacency,
  computeVisibleThreadIds,
  swimLaneLayout,
} from './swimLaneLayout'
import type { ThreadEdge, ThreadNode } from '@/lib/services/ThreadService'

function node(
  id: string,
  domain: ThreadNode['domain'],
  itemType = 'Part',
): ThreadNode {
  return {
    id,
    masterId: `${id}-master`,
    itemNumber: id.toUpperCase(),
    name: id,
    itemType,
    revision: 'A',
    state: 'Released',
    domain,
    designId: null,
    designCode: null,
    designName: null,
    isFocalItem: false,
  }
}

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  relationshipType: string,
  domain: ThreadEdge['domain'] = 'cross',
): ThreadEdge {
  return {
    id,
    sourceId,
    targetId,
    relationshipType,
    domain,
    quantity: null,
    derivationMethod: null,
  }
}

describe('swimLaneLayout edge handle orientation', () => {
  const ebomPart = node('part', 'engineering')
  const mbomPart = node('mpart', 'manufacturing')
  const instance = node('unit', 'physical', 'PhysicalPart')
  const workOrder = node('wo', 'physical', 'WorkOrder')

  it('connects against-flow edges (physical instance → EBOM part) via the flipped handle pair', () => {
    // INSTANCE_OF is emitted physical-side-as-source by ThreadService; the
    // edge must leave the TOP of the instance and enter the BOTTOM of the
    // EBOM part — the sides that face each other across the lanes.
    const { edges } = swimLaneLayout(
      [ebomPart, instance],
      [edge('e1', instance.id, ebomPart.id, 'INSTANCE_OF')],
    )

    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      source: instance.id,
      target: ebomPart.id,
      sourceHandle: THREAD_HANDLE_SOURCE_ALT,
      targetHandle: THREAD_HANDLE_TARGET_ALT,
    })
  })

  it('connects with-flow edges (EBOM → MBOM) via the primary handle pair', () => {
    const { edges } = swimLaneLayout(
      [ebomPart, mbomPart],
      [edge('e1', ebomPart.id, mbomPart.id, 'EBOM_SOURCE')],
    )

    expect(edges[0]).toMatchObject({
      sourceHandle: THREAD_HANDLE_SOURCE,
      targetHandle: THREAD_HANDLE_TARGET,
    })
  })

  it('connects same-lane edges via the primary handle pair', () => {
    const { edges } = swimLaneLayout(
      [workOrder, instance],
      [edge('e1', workOrder.id, instance.id, 'Produces', 'same')],
    )

    expect(edges[0]).toMatchObject({
      sourceHandle: THREAD_HANDLE_SOURCE,
      targetHandle: THREAD_HANDLE_TARGET,
    })
  })

  it('stacks lanes so physical nodes sit below engineering nodes (TB)', () => {
    const { nodes } = swimLaneLayout(
      [ebomPart, instance],
      [edge('e1', instance.id, ebomPart.id, 'INSTANCE_OF')],
    )

    const partNode = nodes.find((n) => n.id === ebomPart.id)!
    const instanceNode = nodes.find((n) => n.id === instance.id)!
    expect(instanceNode.position.y).toBeGreaterThan(partNode.position.y)
  })

  it('renders requirements and validation lanes with correct edge orientation', () => {
    // SATISFIES runs part → requirement (against lane order: requirements
    // stack above engineering) and VERIFIED_BY runs test → requirement
    // (validation sits directly below requirements).
    const requirement = node('req', 'requirements', 'Requirement')
    const testCase = node('tc', 'validation', 'TestCase')
    const { nodes, edges } = swimLaneLayout(
      [ebomPart, requirement, testCase],
      [
        edge('e1', ebomPart.id, requirement.id, 'SATISFIES'),
        edge('e2', testCase.id, requirement.id, 'VERIFIED_BY'),
      ],
    )

    const reqNode = nodes.find((n) => n.id === requirement.id)!
    const testNode = nodes.find((n) => n.id === testCase.id)!
    const partNode = nodes.find((n) => n.id === ebomPart.id)!
    expect(reqNode.position.y).toBeLessThan(testNode.position.y)
    expect(testNode.position.y).toBeLessThan(partNode.position.y)

    for (const laidOut of edges) {
      expect(laidOut).toMatchObject({
        sourceHandle: THREAD_HANDLE_SOURCE_ALT,
        targetHandle: THREAD_HANDLE_TARGET_ALT,
      })
    }
  })

  it('drops edges whose endpoints are not in the node set', () => {
    const requirement = node('req', 'requirements', 'Requirement')
    const { edges } = swimLaneLayout(
      [ebomPart],
      [edge('e1', ebomPart.id, requirement.id, 'SATISFIES')],
    )

    expect(edges).toHaveLength(0)
  })
})

describe('thread expand/collapse visibility', () => {
  // Thread shape: focal EBOM part with one physical instance, which was
  // produced by a work order. The INSTANCE_OF edge is emitted physical-side
  // -as-source, so display direction must invert it: the instance is BELOW
  // the part on screen and must collapse with the part's "down" toggle.
  const part = node('part', 'engineering')
  const instance = node('unit', 'physical', 'PhysicalPart')
  const workOrder = node('wo', 'physical', 'WorkOrder')
  const nodes = [part, instance, workOrder]
  const edges = [
    edge('e-inst', instance.id, part.id, 'INSTANCE_OF'),
    edge('e-prod', workOrder.id, instance.id, 'Produces', 'same'),
  ]
  const adjacency = buildThreadAdjacency(nodes, edges)

  it('treats the lane-earlier endpoint as the display parent regardless of edge direction', () => {
    expect(adjacency.down.get(part.id)).toEqual(new Set([instance.id]))
    expect(adjacency.up.get(instance.id)).toEqual(
      new Set([part.id, workOrder.id]),
    )
    expect(adjacency.down.get(workOrder.id)).toEqual(new Set([instance.id]))
  })

  it('shows everything when nothing is collapsed', () => {
    const visible = computeVisibleThreadIds(
      part.id,
      nodes,
      adjacency,
      new Map(),
    )
    expect(visible).toEqual(new Set([part.id, instance.id, workOrder.id]))
  })

  it('collapsing the focal part downward hides the instance and its work order', () => {
    const collapsed = new Map([[part.id, { up: false, down: true }]])
    const visible = computeVisibleThreadIds(
      part.id,
      nodes,
      adjacency,
      collapsed,
    )
    expect(visible).toEqual(new Set([part.id]))
  })

  it('collapsing a mid node cuts off only nodes reachable through it', () => {
    // From the instance as focal: collapsing its "up" hides both the part
    // and the producing work order (they are display parents).
    const collapsed = new Map([[instance.id, { up: true, down: false }]])
    const visible = computeVisibleThreadIds(
      instance.id,
      nodes,
      adjacency,
      collapsed,
    )
    expect(visible).toEqual(new Set([instance.id]))
  })

  it('falls back to showing every node when the focal item is not rendered', () => {
    const visible = computeVisibleThreadIds(
      'not-in-graph',
      nodes,
      adjacency,
      new Map([[part.id, { up: true, down: true }]]),
    )
    expect(visible).toEqual(new Set([part.id, instance.id, workOrder.id]))
  })
})
