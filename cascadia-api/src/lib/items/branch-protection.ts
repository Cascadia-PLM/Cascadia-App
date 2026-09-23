// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Whether an item type is outside the ECO/branch-protection machinery.
 *
 * Derived from configuration, not a type list: only `Driven` lifecycles are
 * ECO-controlled, so a type whose lifecycle is known to be `Free` or
 * `Driving` is exempt. That covers WorkInstruction (Free — shop-floor
 * procedures are revised informally; the frozen record is the work-order
 * traveler snapshot) and ChangeOrder (Driving — the control object that
 * creates branches; gating it on branch state would be circular), and it
 * means a custom type's exemption follows its assigned lifecycle with no
 * code change here.
 *
 * Fails closed. The exemption is an allow-list of the two kinds known not to
 * need protection, not "anything but Driven": a type whose kind cannot be
 * resolved (`null` — nothing assigned, or an assignment matching no row) is
 * protected, and a lookup that errors propagates rather than answering. It
 * used to be `!== 'Driven'` over a helper that answered 'Free' for every
 * failure, so a transient database error while loading a Part's lifecycle
 * exempted that write and let it through to a protected main.
 *
 * Exemption covers **branch protection only**. Checkout locks still apply: an
 * exempt item checked out by another user is still locked against you.
 */
export async function isBranchProtectionExempt(
  itemType: string,
): Promise<boolean> {
  const { LifecycleService } = await import('../services/LifecycleService')
  const lifecycleType = await LifecycleService.getLifecycleType(itemType)
  return lifecycleType === 'Free' || lifecycleType === 'Driving'
}
