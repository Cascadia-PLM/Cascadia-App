/**
 * artifact-diff tests — complex-algorithm gate.
 *
 * The diff drives the review-stage change display; wrong classification
 * (missed modification, phantom "added") misleads the reviewer. Invariants:
 * added/removed/modified detection keyed by tempId, deep re-parent
 * detection, curated field-change lists, review-metadata exclusion, and
 * null-base handling.
 */

import { describe, expect, it } from 'vitest'
import { diffBom, diffRequirements } from './artifact-diff'
import type { BomDraft, BomNodeDraft, RequirementDraft } from './types'

function req(
  tempId: string,
  overrides: Partial<RequirementDraft> = {},
): RequirementDraft {
  return {
    tempId,
    name: `Requirement ${tempId}`,
    description: 'desc',
    requirementType: 'Functional',
    priority: 'medium',
    verificationMethod: 'Test',
    rationale: 'because',
    confidence: 0.9,
    source: 'ai',
    ...overrides,
  }
}

function node(
  tempId: string,
  overrides: Partial<BomNodeDraft> = {},
): BomNodeDraft {
  return {
    tempId,
    name: `Node ${tempId}`,
    isNew: true,
    quantity: 1,
    children: [],
    requirementTempIds: [],
    rationale: '',
    confidence: 0.8,
    partType: 'Manufacture',
    ...overrides,
  }
}

function bom(root: BomNodeDraft): BomDraft {
  return {
    rootAssembly: root,
    proposedParts: [],
    requirementsCoverage: {},
    uncoveredRequirements: [],
    validationIssues: [],
  }
}

describe('diffRequirements', () => {
  it('classifies added, removed, modified, and unchanged items', () => {
    const base = [req('a'), req('b'), req('c')]
    const current = [
      req('a'), // unchanged
      req('b', { priority: 'critical' }), // modified
      req('d'), // added
    ]

    const diff = diffRequirements(base, current)

    expect(diff.byTempId.get('a')!.status).toBe('unchanged')
    expect(diff.byTempId.get('b')!.status).toBe('modified')
    expect(diff.byTempId.get('d')!.status).toBe('added')
    expect(diff.removed.map((r) => r.tempId)).toEqual(['c'])
    expect(diff.hasChanges).toBe(true)
  })

  it('reports field-level changes with old and new values', () => {
    const base = [req('a', { name: 'Old name', priority: 'low' })]
    const current = [req('a', { name: 'New name', priority: 'high' })]

    const changes = diffRequirements(base, current).byTempId.get('a')!
      .fieldChanges
    expect(changes).toContainEqual({
      fieldName: 'name',
      oldValue: 'Old name',
      newValue: 'New name',
    })
    expect(changes).toContainEqual({
      fieldName: 'priority',
      oldValue: 'low',
      newValue: 'high',
    })
  })

  it('ignores review metadata — accepting an item is not a content change', () => {
    const base = [req('a')]
    const current = [
      req('a', { reviewStatus: 'accepted', reviewNote: 'looks good' }),
    ]

    const diff = diffRequirements(base, current)
    expect(diff.byTempId.get('a')!.status).toBe('unchanged')
    expect(diff.hasChanges).toBe(false)
  })

  it('identical lists produce no changes', () => {
    const base = [req('a'), req('b')]
    const diff = diffRequirements(base, [req('a'), req('b')])
    expect(diff.hasChanges).toBe(false)
    expect(diff.removed).toHaveLength(0)
  })
})

describe('diffBom', () => {
  it('classifies added, removed, and modified nodes across the tree', () => {
    const base = bom(
      node('root', {
        children: [
          node('a'),
          node('b', { children: [node('b1', { quantity: 2 })] }),
        ],
      }),
    )
    const current = bom(
      node('root', {
        children: [
          node('a'), // unchanged
          node('b', { children: [node('b1', { quantity: 5 })] }), // b1 modified
          node('c'), // added
        ],
      }),
    )

    const diff = diffBom(base, current)
    expect(diff.byTempId.get('a')!.status).toBe('unchanged')
    expect(diff.byTempId.get('b1')!.status).toBe('modified')
    expect(diff.byTempId.get('b1')!.fieldChanges).toContainEqual({
      fieldName: 'quantity',
      oldValue: 2,
      newValue: 5,
    })
    expect(diff.byTempId.get('c')!.status).toBe('added')
    expect(diff.removed).toHaveLength(0)
    expect(diff.hasChanges).toBe(true)
  })

  it('detects deep re-parenting as modified + reparented', () => {
    const base = bom(
      node('root', {
        children: [
          node('subA', { partType: 'Phantom', children: [node('leaf')] }),
          node('subB', { partType: 'Phantom', children: [] }),
        ],
      }),
    )
    const current = bom(
      node('root', {
        children: [
          node('subA', { partType: 'Phantom', children: [] }),
          node('subB', { partType: 'Phantom', children: [node('leaf')] }),
        ],
      }),
    )

    const diff = diffBom(base, current)
    const leafDiff = diff.byTempId.get('leaf')!
    expect(leafDiff.status).toBe('modified')
    expect(leafDiff.reparented).toBe(true)
    // Parents themselves have unchanged content fields
    expect(diff.byTempId.get('subA')!.status).toBe('unchanged')
  })

  it('records removed nodes with their old parent name', () => {
    const base = bom(
      node('root', {
        name: 'Root Assembly',
        children: [node('gone', { name: 'Obsolete Bracket' })],
      }),
    )
    const current = bom(node('root', { name: 'Root Assembly', children: [] }))

    const diff = diffBom(base, current)
    expect(diff.removed).toEqual([
      {
        tempId: 'gone',
        name: 'Obsolete Bracket',
        parentName: 'Root Assembly',
      },
    ])
  })

  it('treats interface/mapping count changes as modifications', () => {
    const iface = {
      id: 'i1',
      description: '4x M4 holes',
      mateType: 'coaxial' as const,
      geometry: {
        shape: 'circular' as const,
        nominalDimensions: { diameter: 4 },
        units: 'mm' as const,
      },
      locationHint: 'bottom',
    }
    const base = bom(node('root', { children: [node('a')] }))
    const current = bom(
      node('root', { children: [node('a', { interfaces: [iface] })] }),
    )

    const diff = diffBom(base, current)
    expect(diff.byTempId.get('a')!.status).toBe('modified')
    expect(diff.byTempId.get('a')!.fieldChanges).toContainEqual({
      fieldName: 'interfaces',
      oldValue: 0,
      newValue: 1,
    })
  })

  it('ignores review metadata and generation state on nodes', () => {
    const base = bom(node('root', { children: [node('a')] }))
    const current = bom(
      node('root', {
        children: [
          node('a', {
            reviewStatus: 'accepted',
            cadGeneration: { status: 'complete' },
          }),
        ],
      }),
    )

    expect(diffBom(base, current).hasChanges).toBe(false)
  })

  it('handles a null base (everything added) and null current (everything removed)', () => {
    const tree = bom(node('root', { children: [node('a')] }))

    const added = diffBom(null, tree)
    expect(added.byTempId.get('root')!.status).toBe('added')
    expect(added.byTempId.get('a')!.status).toBe('added')

    const removed = diffBom(tree, null)
    expect(removed.removed.map((n) => n.tempId).sort()).toEqual(['a', 'root'])
  })
})
