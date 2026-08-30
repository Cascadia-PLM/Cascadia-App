// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { UpstreamChangeItem } from '@/lib/db/schema'

/**
 * Lets an optional module react to an ECO release without core knowing the
 * module exists — the post-release sibling of `ApprovalRegistry`.
 *
 * Core owns the release: the merge, revision assignment, and the transaction
 * around them. Hooks run **after** that transaction has committed, alongside
 * core's own post-release dispatches (notifications, superseded-PDF stamps),
 * and under the same contract: a hook failure is logged and never rolls back
 * or blocks a release that has already happened. A hook that needs retry
 * semantics should queue a job rather than doing slow work inline.
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
