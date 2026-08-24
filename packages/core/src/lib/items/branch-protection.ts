// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Whether an item type is outside the ECO/branch-protection machinery.
 *
 * Derived from configuration, not a type list: only `Driven` lifecycles are
 * ECO-controlled, so anything else is exempt. That covers WorkInstruction
 * (Free — shop-floor procedures are revised informally; the frozen record is
 * the work-order traveler snapshot) and ChangeOrder (Driving — the control
 * object that creates branches; gating it on branch state would be circular),
 * and it means a custom type's exemption follows its assigned lifecycle with
 * no code change here.
 *
 * Exemption covers **branch protection only**. Checkout locks still apply: an
 * exempt item checked out by another user is still locked against you.
 */
export async function isBranchProtectionExempt(
  itemType: string,
): Promise<boolean> {
  const { LifecycleService } = await import('../services/LifecycleService')
  return (await LifecycleService.getLifecycleType(itemType)) !== 'Driven'
}
