// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db'
import { itemRelationships, items } from '../db/schema'
import type { BranchProtectionScope } from '@cascadia/commons/types/program'

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

// ============================================================================
// The main-branch edit policy
// ============================================================================

/**
 * What a design's main branch protects, as one summary.
 *
 * `isProtected` is the design-level fact — something in it is released, so
 * main is under change control. What that protects is the program's
 * `BranchProtectionScope`. The two booleans below are the design-wide answers
 * the status endpoints report; the answer for one item is `canEditOnMain`.
 */
export interface MainProtectionSummary {
  isProtected: boolean
  scope: BranchProtectionScope
  /**
   * Every item on main may be edited directly. False whenever main is
   * protected — under `released-items` too, where the answer depends on the
   * item.
   */
  everyItemEditable: boolean
  /** A new item, in its lifecycle's initial state, may be created on main. */
  canCreateOnMain: boolean
}

export async function getMainProtectionSummary(
  designId: string,
): Promise<MainProtectionSummary> {
  const { BranchService } = await import('../services/BranchService')
  const isProtected = await BranchService.isMainBranchProtected(designId)
  const scope = await BranchService.getBranchProtectionScope(designId)
  return {
    isProtected,
    scope,
    everyItemEditable: !isProtected,
    // A new row starts unreleased and nothing lists it yet, so under
    // `released-items` it has nothing above it to protect it.
    canCreateOnMain: !isProtected || scope === 'released-items',
  }
}

/** Why a protected main refuses a direct write. */
export type MainEditRefusal =
  /** `design` scope: the design has released items, so all of main is frozen. */
  | 'design-protected'
  /** `released-items` scope: the item is itself released lineage. */
  | 'item-released'
  /**
   * `released-items` scope: the item sits in the BOM, on main, beneath an
   * item that is released — so editing it, or its structure, would change
   * that released assembly without a change order.
   */
  | 'beneath-released-item'

export interface MainEditDecision {
  allowed: boolean
  refusal: MainEditRefusal | null
  /** One sentence for an error message; null when allowed. */
  reason: string | null
  /** For `beneath-released-item`: the nearest released item above it. */
  releasedAncestor: {
    itemId: string
    masterId: string
    itemNumber: string
  } | null
}

/**
 * What the policy is asked about: an existing item (its `masterId`), or one
 * about to be created (no `masterId`).
 */
export interface MainEditTarget {
  designId: string
  /** Null when it cannot be resolved; treated as not exempt (fails closed). */
  itemType: string | null
  /** An existing item's master. Omitted for an item not yet created. */
  masterId?: string | null
  /**
   * For an existing item, the state of the row being written, checked in
   * addition to the item as it stands on main. For a new item, the state it
   * will be created in; omitted means its lifecycle's initial state.
   */
  state?: string | null
}

const ALLOWED: MainEditDecision = {
  allowed: true,
  refusal: null,
  reason: null,
  releasedAncestor: null,
}

function refuse(
  refusal: MainEditRefusal,
  reason: string,
  releasedAncestor: MainEditDecision['releasedAncestor'] = null,
): MainEditDecision {
  return { allowed: false, refusal, reason, releasedAncestor }
}

/**
 * Can this item on main be edited directly? The one answer to that question.
 *
 * Every gate asks here — `ItemService.create` and the content-edit policy
 * (`ItemEditPolicy.requireContentEditable`, which field updates, deletes and
 * structure edits all pass), `CheckoutService.checkout` and `.createOnBranch`
 * on main, the edit-context the detail pages drive their Edit button from, and
 * the AI write tools' change-order suggestion — so none of them can disagree
 * with another about what a protected main allows.
 *
 * 1. A type exempt from branch protection (a Free or Driving lifecycle) is
 *    always editable on main.
 * 2. Before anything in the design is released, main is unprotected.
 * 3. Under the `design` scope (the default), a protected main refuses every
 *    other direct write.
 * 4. Under `released-items`, it refuses an item that is released lineage —
 *    the row being written, or the item as main currently resolves it
 *    (`VersionResolver.getReleasedVersion`, never an arbitrary row of the
 *    master) — and an item that sits, at any depth, in the BOM on main beneath
 *    a released item. A released assembly does not require its children to be
 *    released, so without the second rule a Draft child — and any BOM line
 *    added under it — would change the released assembly with no change order.
 *    Everything else is editable on main.
 *
 * Released means the item's own lifecycle's released family
 * (`LifecycleService.isReleasedFamilyState`), never a state name.
 */
export async function canEditOnMain(
  target: MainEditTarget,
): Promise<MainEditDecision> {
  if (
    target.itemType !== null &&
    (await isBranchProtectionExempt(target.itemType))
  ) {
    return ALLOWED
  }

  // The same two reads as `getMainProtectionSummary`, the scope only once it
  // matters: this runs on every content edit, and most of them are on an
  // unreleased design.
  const { BranchService } = await import('../services/BranchService')
  if (!(await BranchService.isMainBranchProtected(target.designId))) {
    return ALLOWED
  }

  if (
    (await BranchService.getBranchProtectionScope(target.designId)) === 'design'
  ) {
    return refuse(
      'design-protected',
      'Design has released items. Use an ECO or workspace branch to make changes.',
    )
  }

  const { LifecycleService } = await import('../services/LifecycleService')
  const isNew = !target.masterId

  // The row being written, or the state a new item will start in.
  const state =
    isNew && target.state === undefined && target.itemType !== null
      ? await LifecycleService.getInitialStateId(target.itemType)
      : target.state
  if (
    target.itemType !== null &&
    (await LifecycleService.isReleasedFamilyState(target.itemType, state))
  ) {
    return refuse(
      'item-released',
      isNew
        ? 'A new item cannot start in a released state on main. Release it through a change order.'
        : 'This item is released. Use an ECO or workspace branch to revise it.',
    )
  }

  if (!target.masterId) return ALLOWED

  const { VersionResolver } = await import('../services/VersionResolver')
  const onMain = await VersionResolver.getReleasedVersion(
    target.masterId,
    target.designId,
  )
  if (
    onMain &&
    (await LifecycleService.isReleasedFamilyState(
      onMain.itemType,
      onMain.state,
    ))
  ) {
    return refuse(
      'item-released',
      'This item is released. Use an ECO or workspace branch to revise it.',
    )
  }

  const ancestor = await findReleasedAncestorOnMain(
    target.masterId,
    target.designId,
  )
  if (ancestor) {
    return refuse(
      'beneath-released-item',
      `It is in the structure of released item ${ancestor.itemNumber}. Use an ECO or workspace branch to change it.`,
      ancestor,
    )
  }

  return ALLOWED
}

/**
 * The nearest item above `masterId` in this design's BOM on main whose state
 * is released lineage, or null.
 *
 * Walks parent lines upward a level at a time. A line names an item
 * *version*, and a merge re-points only the lines of the items it touched, so
 * a line is matched to its child by the child's master — the same rule as
 * `ImpactAssessmentService.findWhereUsed`. A parent counts only when its row
 * is the one main currently resolves for that parent's master
 * (`VersionResolver.getReleasedItems`): a superseded revision, or a branch's
 * working copy, still carries lines but is not main's structure.
 *
 * Within the design only, like the protection it refines; a released assembly
 * in another design that references this one is that design's baseline.
 * Cycle-safe by master: each master is expanded once.
 */
async function findReleasedAncestorOnMain(
  masterId: string,
  designId: string,
): Promise<{ itemId: string; masterId: string; itemNumber: string } | null> {
  const { LifecycleService } = await import('../services/LifecycleService')
  const parent = alias(items, 'protection_parent')
  const child = alias(items, 'protection_child')

  const parentsOf = (childMasterIds: Array<string>) =>
    db
      .selectDistinct({
        id: parent.id,
        masterId: parent.masterId,
        itemType: parent.itemType,
        itemNumber: parent.itemNumber,
        state: parent.state,
      })
      .from(itemRelationships)
      .innerJoin(child, eq(child.id, itemRelationships.targetId))
      .innerJoin(parent, eq(parent.id, itemRelationships.sourceId))
      .where(
        and(
          eq(itemRelationships.relationshipType, 'BOM'),
          inArray(child.masterId, childMasterIds),
          eq(parent.designId, designId),
        ),
      )
      .orderBy(parent.itemNumber, parent.id)

  // Main's resolution of the whole design, read only once a parent line
  // exists at all — most items being edited are in no assembly.
  let mainItemIds: Set<string> | null = null
  const visited = new Set([masterId])
  let frontier = [masterId]

  while (frontier.length > 0) {
    const parents = await parentsOf(frontier)
    if (parents.length === 0) return null

    if (!mainItemIds) {
      const { VersionResolver } = await import('../services/VersionResolver')
      const onMain = await VersionResolver.getReleasedItems(designId)
      mainItemIds = new Set(onMain.items.map((row) => row.id))
    }

    const next: Array<string> = []
    for (const row of parents) {
      if (!mainItemIds.has(row.id)) continue
      if (
        await LifecycleService.isReleasedFamilyState(row.itemType, row.state)
      ) {
        return {
          itemId: row.id,
          masterId: row.masterId,
          itemNumber: row.itemNumber,
        }
      }
      if (!visited.has(row.masterId)) {
        visited.add(row.masterId)
        next.push(row.masterId)
      }
    }
    frontier = next
  }

  return null
}
