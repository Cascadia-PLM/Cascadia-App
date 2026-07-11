import { describe, expect, it } from 'vitest'
import { detectMirrorCandidates } from './mirror-detection'
import type { BomNodeDraft } from '../types'

function leaf(
  tempId: string,
  name: string,
  overrides: Partial<BomNodeDraft> = {},
): BomNodeDraft {
  return {
    tempId,
    name,
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

function assembly(
  tempId: string,
  name: string,
  children: Array<BomNodeDraft>,
): BomNodeDraft {
  return leaf(tempId, name, { partType: 'Phantom', children })
}

describe('detectMirrorCandidates', () => {
  it('groups left/right and front/rear split siblings by their shared base name', () => {
    const root = assembly('root', 'Steel Frame', [
      leaf('a', 'Longitudinal Frame Member, Left'),
      leaf('b', 'Longitudinal Frame Member, Right'),
      leaf('c', 'Front Frame Member'),
      leaf('d', 'Rear Frame Member'),
      leaf('e', 'Mid Frame Brace 1'),
      leaf('f', 'Mid Frame Brace 2'),
    ])

    const groups = detectMirrorCandidates(root)
    const byBase = Object.fromEntries(
      groups.map((g) => [g.baseName, g.members.map((m) => m.tempId).sort()]),
    )

    expect(byBase['longitudinal frame member']).toEqual(['a', 'b'])
    expect(byBase['front frame member'] ?? byBase['frame member']).toEqual([
      'c',
      'd',
    ])
    expect(byBase['mid frame brace']).toEqual(['e', 'f'])
  })

  it('does not group siblings that differ by more than a mirror qualifier', () => {
    const root = assembly('root', 'Enclosure', [
      leaf('a', 'Mounting Plate'),
      leaf('b', 'Cover Plate'),
      leaf('c', 'Base Bracket'),
    ])

    // "mounting plate" / "cover plate" / "base bracket" have distinct bases —
    // none of the distinguishing tokens are mirror qualifiers.
    expect(detectMirrorCandidates(root)).toEqual([])
  })

  it('does not group parts of different part types or materials', () => {
    const root = assembly('root', 'Panel', [
      leaf('a', 'Side Panel, Left', { partType: 'Manufacture' }),
      leaf('b', 'Side Panel, Right', { partType: 'Purchase' }),
      leaf('c', 'Trim, Left', { material: 'Aluminum' }),
      leaf('d', 'Trim, Right', { material: 'Steel' }),
    ])

    expect(detectMirrorCandidates(root)).toEqual([])
  })

  it('ignores assembly nodes that carry their own children', () => {
    const root = assembly('root', 'Robot', [
      assembly('arm-l', 'Arm Assembly, Left', [leaf('m1', 'Motor')]),
      assembly('arm-r', 'Arm Assembly, Right', [leaf('m2', 'Motor')]),
    ])

    // The arm assemblies are mirror-named but have sub-trees, so they are not
    // safe auto-consolidation candidates.
    const groups = detectMirrorCandidates(root)
    expect(groups.map((g) => g.baseName)).not.toContain('arm assembly')
  })

  it('sums nothing but reports quantities and parent context per group', () => {
    const root = assembly('root', 'Chassis', [
      leaf('a', 'Wheel Mount, Left', { quantity: 1 }),
      leaf('b', 'Wheel Mount, Right', { quantity: 1 }),
    ])

    const groups = detectMirrorCandidates(root)
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect(group.parentTempId).toBe('root')
    expect(group.parentName).toBe('Chassis')
    expect(group.members.map((m) => m.quantity)).toEqual([1, 1])
  })

  it('requires every member to carry a qualifier (a lone base name is not a split)', () => {
    const root = assembly('root', 'Frame', [
      leaf('a', 'Frame Member'),
      leaf('b', 'Frame Member, Left'),
    ])

    // "Frame Member" has no qualifier — treat this as an intentional distinct
    // part rather than a mirror split.
    expect(detectMirrorCandidates(root)).toEqual([])
  })
})
