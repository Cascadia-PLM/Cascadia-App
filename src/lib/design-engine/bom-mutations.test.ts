import { describe, expect, it } from 'vitest'
import {
  addBomNodeChild,
  recomputeBomDerivedFields,
  removeBomNode,
  updateBomNode,
} from './bom-mutations'
import type { BomDraft, BomNodeDraft } from './types'

function leaf(
  tempId: string,
  overrides: Partial<BomNodeDraft> = {},
): BomNodeDraft {
  return {
    tempId,
    name: tempId,
    isNew: true,
    quantity: 1,
    children: [],
    requirementTempIds: [],
    rationale: '',
    confidence: 1,
    partType: 'Manufacture',
    ...overrides,
  }
}

function makeBom(): BomDraft {
  return {
    rootAssembly: leaf('root', {
      name: 'Root',
      partType: 'Phantom',
      children: [
        leaf('a', { requirementTempIds: ['r1'] }),
        leaf('b', {
          children: [
            leaf('b1', { requirementTempIds: ['r2'] }),
            leaf('b2'),
          ],
        }),
      ],
    }),
    proposedParts: [],
    requirementsCoverage: {},
    uncoveredRequirements: [],
    validationIssues: [],
  }
}

describe('bom-mutations', () => {
  it('updateBomNode produces a new tree without mutating the input', () => {
    const before = makeBom()
    const snapshot = JSON.stringify(before)
    const after = updateBomNode(before, 'b1', { quantity: 5, name: 'B1!' })

    expect(JSON.stringify(before)).toBe(snapshot) // unchanged
    expect(after).not.toBe(before)

    const b = after.rootAssembly.children.find((n) => n.tempId === 'b')!
    const b1 = b.children.find((n) => n.tempId === 'b1')!
    expect(b1.quantity).toBe(5)
    expect(b1.name).toBe('B1!')
  })

  it('removeBomNode re-parents children to the removed node parent', () => {
    const before = makeBom()
    const after = removeBomNode(before, 'b')

    const ids = after.rootAssembly.children.map((c) => c.tempId).sort()
    expect(ids).toEqual(['a', 'b1', 'b2'])
  })

  it('removeBomNode refuses to remove the root assembly', () => {
    const before = makeBom()
    const after = removeBomNode(before, 'root')
    expect(after.rootAssembly.tempId).toBe('root')
    expect(after.rootAssembly.children).toHaveLength(2)
  })

  it('addBomNodeChild inserts under the target parent with a unique tempId', () => {
    const before = makeBom()
    const after = addBomNodeChild(before, 'b', { name: 'b3' })

    const b = after.rootAssembly.children.find((n) => n.tempId === 'b')!
    expect(b.children).toHaveLength(3)

    const newChild = b.children[2]!
    expect(newChild.name).toBe('b3')
    expect(newChild.tempId).toBeTruthy()
    expect(b.children.map((c) => c.tempId)).not.toContain(undefined)
  })

  it('recomputeBomDerivedFields rebuilds coverage and uncovered list', () => {
    const before = makeBom()
    const after = recomputeBomDerivedFields(before, ['r1', 'r2', 'r3'])

    expect(after.requirementsCoverage.r1).toEqual(['a'])
    expect(after.requirementsCoverage.r2).toEqual(['b1'])
    expect(after.uncoveredRequirements).toEqual(['r3'])
  })
})
