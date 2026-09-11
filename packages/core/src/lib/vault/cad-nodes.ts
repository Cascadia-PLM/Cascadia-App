// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

/**
 * Naming an assembly model's parts: the shapes and the matcher, with no
 * database behind them.
 *
 * Split from `CadModelNodeService` so the viewer can import these types
 * without the service's `db` import following them into the client bundle —
 * the failure mode CLAUDE.md records, where `postgres` ends up in a browser
 * build. It has a second payoff: the matching rules below are the part of
 * this feature most worth testing, and here they are testable as arithmetic
 * rather than against a seeded assembly.
 */

/**
 * A PLM part a model node could be bound to: anything in the assembly's BOM,
 * at any depth.
 *
 * The same set the matcher works from, which is deliberate — a person
 * correcting a match should be choosing from what the assembly actually
 * contains, not from every part in the instance. At any depth because a
 * structured GLB flattens to leaf parts, which sit at the bottom of the BOM
 * and not at its first level.
 */
export interface CadModelNodeCandidate {
  itemId: string
  masterId: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
}

/** One selectable part of an assembly model, resolved as far as it can be. */
export interface CadModelNode {
  /** glTF node name — how the viewer addresses this part. */
  nodeKey: string
  /** The part's name as its CAD authored it. */
  name: string
  /** Instance path from the assembly root down to this part. */
  path: Array<string>
  polygonCount?: number
  /** The PLM part this node is, or null when nothing resolved it. */
  part: CadModelNodeCandidate | null
  /**
   * How `part` was arrived at. `manual` and `excluded` are recorded decisions
   * the matcher cannot overrule; `auto` is this read's own guess, and may
   * differ on the next one if the BOM has changed underneath it.
   */
  resolution: 'auto' | 'manual' | 'excluded' | 'unmatched'
}

/**
 * Which node a write is about.
 *
 * In the body rather than the path, though `…/cad-nodes/:nodeKey` reads
 * better. A node key is an instance path — `TDJ-25/ARM-ASSY/BRACKET` — so as a
 * path segment it has to arrive percent-encoded, and `%2F` inside a segment is
 * exactly what a reverse proxy is liable to normalize back into a separator on
 * the way through. That failure is a 404 on some deployments and not others,
 * which is the worst kind to own.
 */
const nodeKeySchema = z.object({
  nodeKey: z.string().min(1),
})

export const setNodeLinkSchema = nodeKeySchema.extend({
  /**
   * The part to bind the node to. `null` records "this is deliberately not a
   * BOM part" — a fixture, a weld bead — which is a different statement from
   * clearing the link, and suppresses the automatic match.
   */
  partItemId: z.string().uuid().nullable(),
})

export const resetNodeLinkSchema = nodeKeySchema

/** A BOM child, plus the two strings a node name could name it by. */
export interface MatchCandidate extends CadModelNodeCandidate {
  normalizedNumber: string
  normalizedName: string
}

/** File extensions CAD tools append to a part name, stripped before matching. */
const CAD_NAME_SUFFIXES = [
  '.sldprt',
  '.sldasm',
  '.prt',
  '.asm',
  '.ipt',
  '.iam',
  '.catpart',
  '.catproduct',
  '.f3d',
  '.step',
  '.stp',
  '.x_t',
  '.fcstd',
]

/**
 * A CAD name reduced to what is worth comparing: lowercased, stripped of the
 * tool's file extension, with spaces, underscores and slashes folded to
 * hyphens.
 *
 * Slashes are in that list because a filename cannot hold one, so a CAD tool
 * substitutes: SolidWorks writes `HSHCS ASME B18.3 - 10-24 UNC x 1_2 …` for a
 * part the BOM calls `… x 1/2 …`, and the fraction in a fastener description
 * is exactly where this bites. Measured on the robot arm's top-level model:
 * 40 of its 225 parts were unmatched on this alone, all of them hardware whose
 * item number carries a fraction. Folding both to the same token is safe in a
 * way a looser rule would not be — the substitution is forced, so a name
 * derived from a filename never legitimately contains the character it
 * replaced.
 *
 * Otherwise deliberately not aggressive. Stripping a trailing `-1` would fold
 * occurrence suffixes together, which is tempting until you notice that
 * `TDJ-25-1042` ends in digits too — and in a PLM a confidently wrong link is
 * worse than an absent one, because nothing about it looks wrong on the way to
 * the wrong part's detail page.
 */
export function normalizeCadName(raw: string): string {
  let name = raw.trim().toLowerCase()
  for (const suffix of CAD_NAME_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length)
      break
    }
  }
  return name
    .replace(/[\s_/\\]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Build a candidate from a BOM child's identity fields.
 *
 * `name` is accepted as null *or* undefined because the two shapes an item
 * arrives in disagree: `PersistedItem` leaves it optional while `BOMTreeNode`
 * nulls it. Normalized to null on the way in, so the matcher sees one thing.
 */
export function toMatchCandidate(target: {
  id: string
  masterId: string
  itemNumber: string
  name?: string | null
  itemType: string
  revision: string
  state: string
}): MatchCandidate {
  return {
    itemId: target.id,
    masterId: target.masterId,
    itemNumber: target.itemNumber,
    name: target.name ?? null,
    itemType: target.itemType,
    revision: target.revision,
    state: target.state,
    normalizedNumber: normalizeCadName(target.itemNumber),
    normalizedName: normalizeCadName(target.name ?? ''),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The BOM child a node name refers to, or null when nothing does — or when
 * more than one thing does.
 *
 * Tried in descending order of how much a match proves: an item number is a
 * near-certain identity, a name a likely one, and an item number appearing as
 * a whole token inside a longer CAD name (`TDJ-25-1042_rev_b`) a plausible
 * one. Ambiguity at the winning tier resolves to null rather than to a coin
 * flip, because the two outcomes do not cost the same: an unmatched node reads
 * as unmatched and someone links it, while a wrongly matched one quietly sends
 * people to the wrong part.
 */
export function matchNode(
  nodeName: string,
  candidates: Array<MatchCandidate>,
): MatchCandidate | null {
  const normalized = normalizeCadName(nodeName)
  if (!normalized) return null

  const tiers: Array<(candidate: MatchCandidate) => boolean> = [
    (c) => c.normalizedNumber !== '' && c.normalizedNumber === normalized,
    (c) => c.normalizedName !== '' && c.normalizedName === normalized,
    (c) =>
      c.normalizedNumber !== '' &&
      // Whole-token containment only: `TDJ-25-104` must not match inside
      // `TDJ-25-1042`, which a bare `includes` would happily let it do.
      new RegExp(`(^|-)${escapeRegExp(c.normalizedNumber)}(-|$)`).test(
        normalized,
      ),
  ]

  for (const matches of tiers) {
    const hits = candidates.filter(matches)
    if (hits.length > 1) return null
    const hit = hits[0]
    if (hit) return hit
  }

  return null
}

/**
 * The BOM child a node stands for, considering the instance path it sits at.
 *
 * `matchNode` alone is enough only when the exporter names the leaf after the
 * part, which SolidWorks does and FreeCAD does not: FreeCAD names the *solid*,
 * so the same assembly arrives as `Tube`, `Plate`, `Gusset`, `Lid` — and the
 * part number sits one level up, in `PUC-1411 Handle Loop, ...`. Measured on
 * the demo cart, matching the leaf alone resolved 0 of PUC-1400's 58 nodes
 * while every one of them had its number in the path.
 *
 * So: the leaf first, because it is the most specific thing on offer, then
 * outward through the enclosing segments. **Nearest first**, and stopping at
 * the first hit — an outer segment is an ancestor assembly, and matching one
 * of those would file the geometry under its container instead of itself,
 * which is a wrong answer rather than a missing one.
 */
export function matchNodeInPath(
  path: Array<string>,
  nodeName: string,
  candidates: Array<MatchCandidate>,
): MatchCandidate | null {
  const direct = matchNode(nodeName, candidates)
  if (direct) return direct

  for (let i = path.length - 1; i >= 0; i--) {
    const segment = path[i]
    // The last segment is normally the leaf name, already tried above.
    if (segment === undefined || segment === nodeName) continue
    const hit = matchNode(segment, candidates)
    if (hit) return hit
  }

  return null
}
