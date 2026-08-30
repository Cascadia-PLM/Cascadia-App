// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Commit consolidation — complex-algorithm gate.
 *
 * consolidateCommits is a pure nodes/edges → nodes/edges function and the one
 * implementation behind all three commit-graph pipelines (design history, ECO
 * branch history, program history). These tests pin its grouping and remapping
 * invariants with no database:
 *
 *  - sequential similar commits inside the 30-minute window group into one
 *    consolidated node (count, aggregated stats, date range); below the
 *    minimum count nothing changes
 *  - important commits (merges, tagged, ECO-linked, initial) never
 *    consolidate and break a group
 *  - edges into and out of a group remap onto the consolidated node id, and
 *    after remapping no edge dangles or self-loops
 *  - that remap is keyed by node.id, so a producer whose node ids differ from
 *    its data.commitId values keeps its boundary edges
 *  - a caller's `shouldGroup` predicate is an additional group boundary
 *  - subtype node data survives consolidation — the program graph's
 *    designId/designCode/designName must still be on the merged node, or the
 *    design columns blank out
 *
 * Run: npx vitest run packages/core/src/lib/versioning/graph-utils.test.ts
 */

import { describe, expect, it } from 'vitest'
import { consolidateCommits, isImportantCommit } from './graph-utils'
import type {
  CommitGraphEdge,
  CommitGraphNode,
  CommitNodeData,
  ProgramCommitGraphNode,
  ProgramCommitNodeData,
} from '@/lib/versioning/graph-types'

const AUTHOR = { id: 'user-1', name: 'Author One' }
const BASE_TIME = new Date('2026-03-01T10:00:00Z').getTime()

function commitNode(
  id: string,
  minutesAfterBase: number,
  overrides: Partial<CommitNodeData> = {},
): CommitGraphNode {
  return {
    id,
    type: 'commitNode',
    position: { x: 0, y: 0 },
    data: {
      commitId: id,
      message: 'Part PN-1000 updated',
      author: AUTHOR,
      date: new Date(BASE_TIME + minutesAfterBase * 60_000).toISOString(),
      branchId: 'branch-main',
      branchName: 'main',
      branchType: 'main',
      isMergeCommit: false,
      changeStats: { added: 0, modified: 1, deleted: 0 },
      tags: [],
      ...overrides,
    },
  }
}

function parentEdge(source: string, target: string): CommitGraphEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    data: { edgeType: 'parent' },
  }
}

/** A commit node carrying the program graph's extra design context. */
function programNode(
  id: string,
  minutesAfterBase: number,
  designId: string,
  overrides: Partial<ProgramCommitNodeData> = {},
): ProgramCommitGraphNode {
  const base = commitNode(id, minutesAfterBase)
  return {
    ...base,
    data: {
      ...base.data,
      designId,
      designCode: `DSN-${designId}`,
      designName: `Design ${designId}`,
      ...overrides,
    },
  }
}

/** After consolidation, every edge endpoint must be a node and never itself. */
function expectWellFormed(result: {
  nodes: Array<CommitGraphNode>
  edges: Array<CommitGraphEdge>
}) {
  const nodeIds = new Set(result.nodes.map((n) => n.id))
  for (const edge of result.edges) {
    expect(nodeIds.has(edge.source), `dangling source ${edge.source}`).toBe(
      true,
    )
    expect(nodeIds.has(edge.target), `dangling target ${edge.target}`).toBe(
      true,
    )
    expect(edge.source).not.toBe(edge.target)
  }
}

describe('consolidateCommits', () => {
  it('groups sequential similar commits inside the window into one node', () => {
    const nodes = [
      commitNode('c1', 0),
      commitNode('c2', 5),
      commitNode('c3', 10, {
        changeStats: { added: 2, modified: 0, deleted: 0 },
      }),
    ]
    const edges = [parentEdge('c3', 'c2'), parentEdge('c2', 'c1')]

    const result = consolidateCommits(nodes, edges)

    expect(result.nodes).toHaveLength(1)
    const merged = result.nodes[0]!
    expect(merged.data.isConsolidated).toBe(true)
    expect(merged.data.consolidatedCount).toBe(3)
    expect(merged.data.consolidatedCommitIds).toEqual(['c1', 'c2', 'c3'])
    expect(merged.data.message).toBe('3 Parts updated')
    // Stats aggregate; the date range spans the group.
    expect(merged.data.changeStats).toEqual({
      added: 2,
      modified: 2,
      deleted: 0,
    })
    expect(merged.data.dateRangeStart).toBe(nodes[0]!.data.date)
    expect(merged.data.dateRangeEnd).toBe(nodes[2]!.data.date)
    // Intra-group edges vanish with the group.
    expect(result.edges).toHaveLength(0)
    expectWellFormed(result)
  })

  it('does not group a commit outside the 30-minute window of the group start', () => {
    const nodes = [
      commitNode('c1', 0),
      commitNode('c2', 10),
      commitNode('c3', 45), // past the window measured from c1
      commitNode('c4', 50),
    ]

    const result = consolidateCommits(nodes, [])

    // Two groups of two, split at the window boundary.
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes.map((n) => n.data.consolidatedCommitIds)).toEqual([
      ['c1', 'c2'],
      ['c3', 'c4'],
    ])
  })

  it('keeps a lone pair below the minimum count only when nothing groups', () => {
    // A single node is below MIN_COMMITS_TO_CONSOLIDATE — untouched.
    const single = consolidateCommits([commitNode('c1', 0)], [])
    expect(single.nodes).toHaveLength(1)
    expect(single.nodes[0]!.data.isConsolidated).toBeUndefined()
  })

  it('never consolidates important commits, and they break a group', () => {
    const nodes = [
      commitNode('c1', 0),
      commitNode('c2', 5),
      commitNode('merge', 10, {
        isMergeCommit: true,
        message: 'Merge ECO branch',
      }),
      commitNode('c3', 15),
      commitNode('c4', 20),
    ]

    const result = consolidateCommits(nodes, [])

    // c1+c2 group, the merge survives alone, c3+c4 group.
    expect(result.nodes).toHaveLength(3)
    const mergeNode = result.nodes.find((n) => n.id === 'merge')
    expect(mergeNode).toBeDefined()
    expect(mergeNode!.data.isConsolidated).toBeUndefined()

    // Tagged and ECO-linked commits are equally important.
    expect(
      isImportantCommit(
        commitNode('t', 0, {
          tags: [{ id: 't1', name: 'v1', tagType: 'release' }],
        }).data,
      ),
    ).toBe(true)
    expect(
      isImportantCommit(commitNode('e', 0, { ecoNumber: 'ECO-000001' }).data),
    ).toBe(true)
    expect(
      isImportantCommit(commitNode('i', 0, { message: 'Initial commit' }).data),
    ).toBe(true)
  })

  it('remaps boundary edges onto the consolidated node with no dangles or self-loops', () => {
    // important ← g1 ← g2 ← g3 (group), then tip ← important on the far side.
    const nodes = [
      commitNode('anchor', 0, { message: 'Initial commit' }),
      commitNode('g1', 5),
      commitNode('g2', 10),
      commitNode('g3', 15),
      commitNode('tip', 20, { isMergeCommit: true, message: 'Merge branch' }),
    ]
    const edges = [
      parentEdge('g1', 'anchor'),
      parentEdge('g2', 'g1'),
      parentEdge('g3', 'g2'),
      parentEdge('tip', 'g3'),
    ]

    const result = consolidateCommits(nodes, edges)

    const consolidated = result.nodes.find((n) => n.data.isConsolidated)
    expect(consolidated).toBeDefined()
    expect(consolidated!.data.consolidatedCommitIds).toEqual(['g1', 'g2', 'g3'])

    // The two boundary edges survive, remapped; intra-group edges are gone.
    expect(result.edges).toHaveLength(2)
    const remapped = result.edges.map((e) => `${e.source}->${e.target}`).sort()
    expect(remapped).toEqual(
      [`${consolidated!.id}->anchor`, `tip->${consolidated!.id}`].sort(),
    )
    expectWellFormed(result)
  })

  it('remaps edges by node id even when node.id and data.commitId differ', () => {
    // Edge endpoints are node ids, so the remap must key off node.id. A
    // producer is free to derive its node ids however it likes — here it
    // prefixes them, `eco-${commit.id}` — and its boundary edges must still
    // survive consolidation.
    const nodes = [
      commitNode('eco-anchor', 0, {
        commitId: 'anchor',
        message: 'Initial commit',
      }),
      commitNode('eco-g1', 5, { commitId: 'g1' }),
      commitNode('eco-g2', 10, { commitId: 'g2' }),
      commitNode('eco-g3', 15, { commitId: 'g3' }),
      commitNode('eco-tip', 20, {
        commitId: 'tip',
        isMergeCommit: true,
        message: 'Merge branch',
      }),
    ]
    const edges = [
      parentEdge('eco-g1', 'eco-anchor'),
      parentEdge('eco-g2', 'eco-g1'),
      parentEdge('eco-g3', 'eco-g2'),
      parentEdge('eco-tip', 'eco-g3'),
    ]

    const result = consolidateCommits(nodes, edges)

    const consolidated = result.nodes.find((n) => n.data.isConsolidated)
    expect(consolidated).toBeDefined()

    // The two boundary edges survive, remapped; intra-group edges are gone.
    expect(result.edges).toHaveLength(2)
    const remapped = result.edges.map((e) => `${e.source}->${e.target}`).sort()
    expect(remapped).toEqual(
      [
        `${consolidated!.id}->eco-anchor`,
        `eco-tip->${consolidated!.id}`,
      ].sort(),
    )
    expectWellFormed(result)
  })

  it('splits groups on author, branch, action, and item-type boundaries', () => {
    const nodes = [
      commitNode('a1', 0),
      commitNode('a2', 2),
      // Different author: breaks the run.
      commitNode('b1', 4, { author: { id: 'user-2', name: 'Other' } }),
      commitNode('b2', 6, { author: { id: 'user-2', name: 'Other' } }),
      // Different action on the same branch/author: breaks again.
      commitNode('d1', 8, {
        author: { id: 'user-2', name: 'Other' },
        message: 'Part PN-1000 deleted',
        changeStats: { added: 0, modified: 0, deleted: 1 },
      }),
    ]

    const result = consolidateCommits(nodes, [])

    expect(
      result.nodes.map((n) => n.data.consolidatedCommitIds ?? n.id),
    ).toEqual([['a1', 'a2'], ['b1', 'b2'], 'd1'])
  })

  it("honours the caller's shouldGroup boundary", () => {
    // Same branch, author, action and item type, all inside the window — only
    // the design differs, so only the program caller's predicate can split it.
    const nodes = [
      programNode('p1', 0, 'design-a'),
      programNode('p2', 2, 'design-a'),
      programNode('p3', 4, 'design-a'),
      programNode('p4', 6, 'design-b'),
      programNode('p5', 8, 'design-b'),
    ]

    const grouped = consolidateCommits(nodes, [], {
      shouldGroup: (current, next) =>
        next.data.designId === current.data.designId,
    })

    // A consolidated node never spans designs.
    expect(
      grouped.nodes.map((n) => n.data.consolidatedCommitIds ?? n.id),
    ).toEqual([
      ['p1', 'p2', 'p3'],
      ['p4', 'p5'],
    ])
    for (const node of grouped.nodes) {
      const members = node.data.consolidatedCommitIds ?? [node.id]
      const designs = new Set(
        members.map(
          (id) => nodes.find((n) => n.data.commitId === id)!.data.designId,
        ),
      )
      expect(designs.size).toBe(1)
    }

    // Without the predicate the same run collapses into one — proving the
    // split above came from shouldGroup and not from another boundary.
    const ungrouped = consolidateCommits(nodes, [])
    expect(ungrouped.nodes).toHaveLength(1)
  })

  it('carries subtype node data onto the consolidated node', () => {
    const nodes = [
      programNode('p1', 0, 'design-a'),
      programNode('p2', 5, 'design-a'),
    ]

    const result = consolidateCommits(nodes, [])

    expect(result.nodes).toHaveLength(1)
    const merged = result.nodes[0]!
    expect(merged.type).toBe('commitNode')
    // The program pipeline and ProgramHistoryGraphView both key design columns
    // off these fields; losing them blanks the graph.
    expect(merged.data.designId).toBe('design-a')
    expect(merged.data.designCode).toBe('DSN-design-a')
    expect(merged.data.designName).toBe('Design design-a')
  })
})
