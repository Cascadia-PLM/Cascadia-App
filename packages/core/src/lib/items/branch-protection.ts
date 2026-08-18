// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Item types that carry a `designId` but are not gated on that design's branch
 * protection.
 *
 * `ChangeOrder` is the workflow control object that creates branches in the
 * first place — gating it on branch state would be circular.
 *
 * `WorkInstruction` is a manufacturing procedure on the Free lifecycle. It
 * inherits a `designId` from its output part so parametric blocks, MBOM
 * inheritance, and part lookups resolve in the right design — but shop-floor
 * procedures are revised far more often, and far more informally, than the
 * engineering they describe. The frozen manufacturing record comes from the
 * work order traveler snapshot, not from ECO control of the template, so
 * requiring an ECO to fix a typo in a torque spec would buy no traceability.
 * See `docs/features/work-instructions.md`.
 *
 * Exemption covers **branch protection only**. Checkout locks still apply: an
 * exempt item checked out by another user is still locked against you.
 */
const BRANCH_PROTECTION_EXEMPT: ReadonlySet<string> = new Set([
  'ChangeOrder',
  'WorkInstruction',
])

export function isBranchProtectionExempt(itemType: string): boolean {
  return BRANCH_PROTECTION_EXEMPT.has(itemType)
}
