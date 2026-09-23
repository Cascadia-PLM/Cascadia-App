// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Checkout status as the items API reports it.
 *
 * `branchItem` is the `branch_items` row the checkout lives on. Its column
 * type is a Drizzle inference the server owns, so it is a parameter here: the
 * server instantiates it with the row type, the client — which never reads the
 * row — leaves it `unknown`.
 */
export interface CheckoutStatus<TBranchItem = unknown> {
  isCheckedOut: boolean
  checkedOutBy?: { id: string; name: string | null; email: string }
  checkedOutAt?: Date
  branchItem?: TBranchItem
}
