// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { catalogValues } from '@cascadia/commons/items/relationships/catalog'
import { isBranchProtectionExempt } from './branch-protection'

/**
 * The requirements-traceability edge types, and the rule for which end of one
 * carries the edit policy. The strings are the catalog's
 * (`@cascadia/commons/items/relationships/catalog`); they are named here so
 * the services can import a constant rather than spell a string.
 */

export const SATISFIES_RELATIONSHIP = 'SATISFIES' // Part/Software/Document → Requirement
export const DERIVES_FROM_RELATIONSHIP = 'DERIVES_FROM' // ChildReq → ParentReq
export const ALLOCATED_TO_RELATIONSHIP = 'ALLOCATED_TO' // Requirement → Part/Software/Document
export const VERIFIED_BY_RELATIONSHIP = 'VERIFIED_BY' // TestCase → Requirement
export const VALIDATES_RELATIONSHIP = 'VALIDATES' // TestCase → Part

/**
 * The architecture edges (systems-engineering Phase 5). `DECOMPOSES` is the
 * tree — a structural edge, guarded on its source like `BOM`, and the one
 * edge type the relationship service refuses a cycle of. `REALIZED_BY` is the
 * hop from the logical element to the item that implements it. `CONNECTS`
 * is an interface between two elements — the lines of the block diagram;
 * unlike the tree it may cross levels and form loops.
 */
export const DECOMPOSES_RELATIONSHIP = 'DECOMPOSES' // SystemElement → SystemElement
export const REALIZED_BY_RELATIONSHIP = 'REALIZED_BY' // SystemElement → Part/Software
export const CONNECTS_RELATIONSHIP = 'CONNECTS' // SystemElement → SystemElement

/**
 * The edge types whose guard falls to the target end when the source is
 * branch-protection exempt — the catalog's `target-when-source-exempt`
 * entries. `VALIDATES` joined on 2026-10-09: with a Free TestCase as its
 * source it had the hole `VERIFIED_BY` was closed for, a validation link
 * writable onto a released part on protected main with no change order.
 */
export const TRACEABILITY_RELATIONSHIP_TYPES: ReadonlySet<string> =
  catalogValues((entry) => entry.guardEnd === 'target-when-source-exempt')

/**
 * Which end of an edge answers for it under the edit-lock policy.
 *
 * Normally the source: an edge is part of the source item's structure, so a
 * BOM line is the parent's content and an `Affects` line is the change
 * order's. Traceability is the exception. `VERIFIED_BY` runs TestCase →
 * Requirement, and TestCase carries a Free lifecycle, so guarding the source
 * was a no-op for branch protection: V&V links were writable straight onto a
 * released requirement on protected main, while `SATISFIES` — the same
 * statement with a Part source — was rejected. Sending the rule to the
 * requirement end when the source is exempt gives every traceability link
 * write one rule: a branch row whose checkout you hold, or main before
 * anything in the design has released.
 *
 * Only traceability edges get the fallback. `Affects` also runs from an exempt
 * source (a ChangeOrder) to a Driven target, and there the source really is
 * the owner — scope management would deadlock if adding an affected item first
 * required that item to be checked out.
 */
export async function resolveEdgeGuardEnd(
  sourceItemType: string,
  relationshipType: string,
): Promise<'source' | 'target'> {
  if (!TRACEABILITY_RELATIONSHIP_TYPES.has(relationshipType)) return 'source'
  return (await isBranchProtectionExempt(sourceItemType)) ? 'target' : 'source'
}
