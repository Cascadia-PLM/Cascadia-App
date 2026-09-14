// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { UpstreamChangeItem } from '@/lib/db/schema'

/**
 * Lets an optional module react to an ECO release without core knowing the
 * module exists — the post-release sibling of `ApprovalRegistry`.
 *
 * @deprecated Register a `consumed` extension on `design.released` instead
 * (`defineExtension` from `@cascadia/core/extensions`). **This registry now has
 * zero registrants in both editions** — the Odoo connector, its last one, moved
 * to a consumer — so the loop in `ChangeOrderMergeService` iterates an empty
 * array on every release. It is kept for one more wave and then removed: it is
 * a documented public API in the published AGPL edition, and deleting it in the
 * same release that deprecated it would give downstream forks no warning.
 *
 * **Why it is superseded rather than merely duplicated.** `afterRelease` runs
 * post-commit with its failure swallowed, so it can only ever observe — it
 * cannot veto, and it cannot report that it failed. What it observes, it
 * observes unreliably: the loop that calls it lives inside `mergeBranchToMain`
 * alone, so a change order releasing through the branchless or state-only arm
 * fires no hook at all, and nothing records that one was owed. A seam whose
 * failures are swallowed cannot report its own gaps.
 *
 * The extension layer does the same job durably: ordered delivery from the
 * event log, retry with backoff, catch-up after an outage, an operator-visible
 * parked state, and coverage of every release arm because it keys on the fact
 * rather than on one code path.
 *
 * **This is not a general verdict on registries.** `ApprovalRegistry` gates a
 * vote before it is written and derives per-request input from the raw HTTP
 * request — a phase handler can do neither — and it stays. So do the slot,
 * route and job registries: contributing a component, a route or a job type is
 * not an event, and nothing about them is improved by a log.
 *
 * Core owns the release: the merge, revision assignment, and the transaction
 * around them. Hooks run **after** that transaction has committed, and a hook
 * failure is logged and never rolls back or blocks a release that has already
 * happened. A hook that needs retry semantics should queue a job rather than
 * doing slow work inline — or, now, be an extension.
 *
 * Core ships zero hooks — with none registered, a release behaves exactly as
 * it did before this seam existed.
 */

export interface ReleaseContext {
  changeOrderId: string
  designId: string
  /** User who executed the release. */
  userId: string
  /** Per-item outcome of the merge: masterIds, revisions, change types. */
  changedItems: Array<UpstreamChangeItem>
  /** itemNumber → newly assigned revision letter. */
  revisionsAssigned: Record<string, string>
}

/**
 * @deprecated Use a `consumed` extension on `design.released`. See the note on
 * `ReleaseHookRegistry` for what that buys and why this cannot provide it.
 */
export interface ReleaseHook {
  /** Identifies the hook in logs and `registered()`. */
  name: string
  /**
   * Runs once per merged design, after the release has committed. Throwing is
   * logged, never propagated.
   */
  afterRelease: (context: ReleaseContext) => Promise<void>
}

export class ReleaseHookRegistry {
  private static hooks: Array<ReleaseHook> = []

  /**
   * Register a hook. Called from a composition root, never from core.
   *
   * Names are unique, for the same reason `ApprovalRegistry` requires it: a
   * duplicate name means the hook fires twice while `registered()` reports it
   * once. Since a hook's failure is swallowed by design, a double-fire is
   * exactly the kind of thing that would never surface — so it throws here.
   */
  static register(hook: ReleaseHook): void {
    if (this.hooks.some((existing) => existing.name === hook.name)) {
      throw new Error(`Release hook "${hook.name}" is already registered`)
    }
    this.hooks.push(hook)
  }

  /** Registered hook names, in registration order. */
  static registered(): Array<string> {
    return this.hooks.map((hook) => hook.name)
  }

  /** Every registered hook, in registration order. */
  static all(): Array<ReleaseHook> {
    return [...this.hooks]
  }

  /** Drop every hook. Tests only. */
  static clear(): void {
    this.hooks = []
  }
}
