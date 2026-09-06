// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { OptionCondition } from './variants'

/**
 * The shape of a BOM tree as it crosses the wire.
 *
 * Two endpoints build one — `GET /designs/:id/structure` and
 * `GET /change-orders/:id/designs/:designId/structure` — and several
 * components render it. Those five declarations used to be four separate
 * copies of this interface, and they had drifted: the client copy was missing
 * `isBranchChanged` that the change-order endpoint emits, the design-structure
 * copy was missing `masterId`, `isInEco` and `changeAction`, and the two server
 * copies disagreed on whether `name` could be null.
 *
 * This is the one declaration. Fields that only one producer emits are
 * optional and say so, which is the honest encoding — a consumer reading a tree
 * cannot tell which endpoint built it from the type alone, so anything not
 * universal has to be treated as possibly absent.
 */
export interface BOMTreeNode {
  itemId: string
  /**
   * Stable across revisions, for deduplicating a part that appears under more
   * than one parent. Only the change-order tree carries it; the design
   * structure endpoint does not emit it.
   */
  masterId?: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  designId?: string | null
  /** Quantity and position on the parent's BOM line; absent on roots. */
  quantity?: number
  findNumber?: number
  /** The BOM relationship joining this node to its parent; absent on roots. */
  relationshipId?: string
  /**
   * Product variants: the option condition on the parent's BOM line, or null
   * for a fixed line. Absent on roots.
   */
  option?: OptionCondition | null
  children?: Array<BOMTreeNode>

  // Cross-design: the node resolves to an item in another design
  designCode?: string
  designName?: string
  isExternal?: boolean
  /** A lightweight reference to another design's item, not a usage copy. */
  isCrossDesignRef?: boolean
  /** The `design_cross_references` row behind `isCrossDesignRef`. */
  crossReferenceId?: string

  // Change-order trees only
  isInEco?: boolean
  /** Changed on the change order's branch, whether or not it is an affected item. */
  isBranchChanged?: boolean
  changeAction?: string | null

  // Design structure trees only
  isInWork?: boolean
}

/**
 * An item in a design that is not part of its BOM tree — a non-Part item, or a
 * Part explicitly excluded from the structure.
 */
export interface OrphanItem {
  id: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string

  // Change-order trees only
  isInEco?: boolean
  isBranchChanged?: boolean
  changeAction?: string | null
}
