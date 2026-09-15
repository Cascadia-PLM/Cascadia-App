// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Server-side options for executing a transition. Kept apart from
 * `./types` — which the web shares — because `afterFinalize` runs inside a
 * database transaction and is typed by the transaction client.
 */

import type { TransactionClient } from '@/lib/db'

export interface TransitionExecutionOptions {
  /**
   * The caller holds the release claim on this instance (taken via
   * LifecycleInstanceService.claimRelease). Allows the transition to proceed while
   * the claim blocks everyone else, and clears the claim on success.
   */
  ownedClaim?: boolean
  /**
   * Runs after guards/approvals/before-actions pass and immediately before
   * the state writes. If it throws, the workflow state is untouched and the
   * error propagates to the caller — used so an ECO only reaches its final
   * state if the merge/cancel actually succeeded.
   */
  beforeFinalize?: () => Promise<void>
  /**
   * Runs inside the transaction that writes the new state — after the
   * instance, the item's mirrored state and the history row are written,
   * before any of it commits. For bookkeeping that has to be exactly as true
   * as the state itself, such as a change order's `submittedAt` and
   * `approvedAt`. If it throws, the whole state write rolls back with it.
   */
  afterFinalize?: (tx: TransactionClient) => Promise<void>
}
