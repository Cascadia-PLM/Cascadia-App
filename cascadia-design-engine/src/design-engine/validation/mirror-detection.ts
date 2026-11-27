// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Mirrored / Duplicate Part Detection
 *
 * A BOM can be *technically* correct (every part accounted for) yet
 * *logistically* wrong: mirror-image or repeated parts recorded as separate
 * line items instead of one line with a higher quantity. For example a frame
 * generated as
 *
 *   - Longitudinal Frame Member, Left  (x1)
 *   - Longitudinal Frame Member, Right (x1)
 *   - Front Frame Member               (x1)
 *   - Rear Frame Member                (x1)
 *
 * should really be
 *
 *   - Longitudinal Frame Member (x2)
 *   - End Frame Member          (x2)
 *
 * This module finds *candidate* groups of sibling nodes that look like they
 * were split this way. It deliberately does not merge anything — deciding
 * whether "top plate" and "bottom plate" are truly the same manufactured item
 * (versus genuinely different parts) is a semantic judgement left to the LLM
 * consolidation pass. The heuristic's job is only to narrow the search so that
 * pass reviews a handful of specific groups rather than the whole tree.
 */

import type { BomNodeDraft } from '../types'

/**
 * Directional / positional / index qualifiers that distinguish mirror or
 * repeated instances of the same part. When two sibling names differ only by
 * tokens in this set, they are likely the same manufactured item.
 */
const MIRROR_QUALIFIERS = new Set<string>([
  // left / right
  'left',
  'right',
  'l',
  'r',
  'lh',
  'rh',
  'port',
  'starboard',
  // front / back
  'front',
  'rear',
  'back',
  'fwd',
  'forward',
  'aft',
  // vertical
  'top',
  'bottom',
  'upper',
  'lower',
  'up',
  'down',
  // in / out
  'inner',
  'outer',
  'inboard',
  'outboard',
  'interior',
  'exterior',
  'near',
  'far',
  // compass
  'north',
  'south',
  'east',
  'west',
  // enumerations
  'a',
  'b',
  'i',
  'ii',
  'iii',
  'iv',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
])

export interface MirrorCandidateMember {
  tempId: string
  name: string
  quantity: number
  partType?: string
}

export interface MirrorCandidateGroup {
  parentTempId: string
  parentName: string
  /** Shared name with mirror qualifiers stripped, e.g. "frame member". */
  baseName: string
  members: Array<MirrorCandidateMember>
}

/**
 * Reduce a part name to its qualifier-free base plus whether any qualifier was
 * actually removed. Two names sharing a non-empty base differ only by mirror
 * qualifiers.
 */
function baseNameOf(name: string): { base: string; hadQualifier: boolean } {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

  const kept: Array<string> = []
  let hadQualifier = false
  for (const token of tokens) {
    if (MIRROR_QUALIFIERS.has(token)) {
      hadQualifier = true
    } else {
      kept.push(token)
    }
  }

  return { base: kept.join(' '), hadQualifier }
}

/**
 * A grouping key that keeps physically distinct parts apart. Parts only group
 * when they share a base name, part type, material, and (if present) parametric
 * shape template — so a "left plate" and "right plate" group, but a plate and a
 * bracket never do, even if both were tagged "left".
 */
function groupKeyOf(node: BomNodeDraft, base: string): string {
  return [
    base,
    node.partType ?? '',
    (node.material ?? '').toLowerCase(),
    node.parametricSpec?.shapeTemplate ?? '',
    node.existingItemId ? 'existing' : 'new',
    // U+0000 as the separator: it cannot occur in any of the joined
    // fields, so the key is unambiguous. Written as an escape rather
    // than a literal NUL byte, which makes git classify the file as
    // binary and exclude it from text normalization and diffs.
  ].join('\u0000')
}

/**
 * Find candidate mirror/duplicate groups among the children of a single
 * assembly node.
 */
function candidatesUnder(parent: BomNodeDraft): Array<MirrorCandidateGroup> {
  // group key -> { base, members }
  const groups = new Map<
    string,
    {
      base: string
      members: Array<MirrorCandidateMember & { hadQualifier: boolean }>
    }
  >()

  for (const child of parent.children) {
    // Only leaf parts are safe to auto-consolidate. Merging assemblies that
    // carry their own sub-trees is ambiguous and left alone.
    if (child.children.length > 0) continue

    const { base, hadQualifier } = baseNameOf(child.name)
    if (!base) continue

    const key = groupKeyOf(child, base)
    let entry = groups.get(key)
    if (!entry) {
      entry = { base, members: [] }
      groups.set(key, entry)
    }
    entry.members.push({
      tempId: child.tempId,
      name: child.name,
      quantity: child.quantity,
      partType: child.partType,
      hadQualifier,
    })
  }

  const result: Array<MirrorCandidateGroup> = []
  for (const { base, members } of groups.values()) {
    // Need at least two siblings, and every one must actually carry a mirror
    // qualifier — otherwise the shared base is a coincidence, not a split part.
    if (members.length < 2) continue
    if (!members.every((m) => m.hadQualifier)) continue

    result.push({
      parentTempId: parent.tempId,
      parentName: parent.name,
      baseName: base,
      members: members.map(({ hadQualifier: _hadQualifier, ...m }) => m),
    })
  }

  return result
}

/**
 * Walk the BOM tree and return every candidate group of sibling parts that
 * appear to be mirror images or repeated instances split into separate lines.
 */
export function detectMirrorCandidates(
  root: BomNodeDraft,
): Array<MirrorCandidateGroup> {
  const candidates: Array<MirrorCandidateGroup> = []

  function walk(node: BomNodeDraft) {
    if (node.children.length > 0) {
      candidates.push(...candidatesUnder(node))
      for (const child of node.children) walk(child)
    }
  }
  walk(root)

  return candidates
}
