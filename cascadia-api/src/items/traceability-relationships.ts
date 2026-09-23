// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { isBranchProtectionExempt } from './branch-protection'

/**
 * The requirements-traceability edge types, and the rule for which end of one
 * carries the edit policy.
 */

export const SATISFIES_RELATIONSHIP = 'SATISFIES' // Part/Document → Requirement
export const DERIVES_FROM_RELATIONSHIP = 'DERIVES_FROM' // ChildReq → ParentReq
export const ALLOCATED_TO_RELATIONSHIP = 'ALLOCATED_TO' // Requirement → Part
export const VERIFIED_BY_RELATIONSHIP = 'VERIFIED_BY' // TestCase → Requirement

export const TRACEABILITY_RELATIONSHIP_TYPES: ReadonlySet<string> = new Set([
  SATISFIES_RELATIONSHIP,
  DERIVES_FROM_RELATIONSHIP,
  ALLOCATED_TO_RELATIONSHIP,
  VERIFIED_BY_RELATIONSHIP,
])

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
