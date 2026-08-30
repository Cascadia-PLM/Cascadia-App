// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { TransactionClient } from '@/lib/db'
import type { SessionUser } from '@/lib/auth/session'

/**
 * Lets an optional module participate in approval voting without core knowing
 * the module exists.
 *
 * Core owns the vote: the permission checks, the duplicate-vote guard, the
 * insert, and the transaction around it. A module can veto a vote before it is
 * written (`beforeVote`) and write its own rows in the same transaction after
 * it is (`afterVote`). Core ships zero interceptors — with none registered,
 * voting behaves exactly as it did before this seam existed.
 *
 * `afterVote` runs **inside** the vote's transaction and is handed the `tx`
 * handle deliberately. Advanced Auditing's signature has to commit or roll back
 * with the vote it authorizes; an approval that exists without its signature,
 * or a signature without its approval, is a compliance defect rather than a
 * cosmetic one. Anything registered here inherits that guarantee, so do not
 * reach for `db` inside an interceptor — use the `tx` you are given.
 */

/**
 * What an approval covers, snapshotted before the vote is written.
 *
 * Modules that bind a signature to an approval need the facts as the signer saw
 * them, not as a later read would report them.
 */
export interface ApprovalAttestation {
  itemId: string | null
  stateName: string
  item: Record<string, unknown> | null
  workflow: Record<string, unknown> | null
}

/**
 * Request-scoped input a module needs and core has no concept of.
 *
 * Empty in core. A module widens it by declaration merging, which keeps the
 * call site in `src/server/routes/` type-safe without core ever naming the
 * module's types:
 *
 * ```typescript
 * declare module '@/lib/workflows/approval-registry' {
 *   interface ApprovalExtras {
 *     signing?: ApprovalSigningContext
 *   }
 * }
 * ```
 */
export interface ApprovalExtras {}

/**
 * Fields a module contributes to the approval response. Widened the same way as
 * {@link ApprovalExtras}.
 */
export interface ApprovalResultExtras {}

export interface ApprovalContext {
  instanceId: string
  stateId: string
  userId: string
  vote: 'approved' | 'rejected'
  roleId: string | null
  roleName: string | null
  comments: string | null
  extras: ApprovalExtras
  /**
   * The approval snapshot, built on first call and memoized.
   *
   * Lazy because building it costs several queries that are pure waste when no
   * interceptor wants it. Call it from `beforeVote` if you need the snapshot
   * taken outside the transaction — the memo means `afterVote` then reuses it
   * rather than re-reading rows the vote itself may have touched.
   */
  attestation: () => Promise<ApprovalAttestation>
}

/**
 * The request an approval arrived on, for interceptors that need to derive
 * something from it.
 *
 * This exists so the API layer never has to name a module's types. A route
 * hands the raw request over and gets back whatever the registered modules want
 * carried into the vote; with nothing registered it gets `{}`, which is what
 * makes core's routes compile with the proprietary packages absent.
 */
export interface ApprovalExtrasInput {
  request: Request
  user: SessionUser
  requestId: string
  /** The already-parsed request body. */
  body: Record<string, unknown>
}

export interface ApprovalInterceptor {
  /** Identifies the interceptor in errors and in `registered()`. */
  name: string
  /**
   * Derive this module's per-request input from the incoming request.
   *
   * Called by the API layer before `submitApproval`; whatever is returned is
   * merged into {@link ApprovalContext.extras}.
   */
  buildExtras?: (
    input: ApprovalExtrasInput,
  ) => ApprovalExtras | Promise<ApprovalExtras>
  /** Runs before the vote is written, outside the transaction. Throw to block it. */
  beforeVote?: (ctx: ApprovalContext) => void | Promise<void>
  /**
   * Runs inside the vote's transaction, after the insert.
   *
   * Returned fields are merged into the approval response. Throwing rolls the
   * vote back.
   */
  afterVote?: (
    voteId: string,
    ctx: ApprovalContext,
    tx: TransactionClient,
  ) => ApprovalResultExtras | void | Promise<ApprovalResultExtras | void>
}

export class ApprovalRegistry {
  private static interceptors: Array<ApprovalInterceptor> = []

  /**
   * Register an interceptor. Called from a composition root, never from core.
   *
   * Names are unique: two interceptors under one name means a module was
   * registered twice, or two modules collided, and either way one of them
   * would silently run twice while reading as a single entry in
   * {@link registered}. Modules guard their own registration once, so this
   * throws rather than deduplicating.
   */
  static register(interceptor: ApprovalInterceptor): void {
    if (this.interceptors.some((i) => i.name === interceptor.name)) {
      throw new Error(
        `Approval interceptor "${interceptor.name}" is already registered`,
      )
    }
    this.interceptors.push(interceptor)
  }

  /** Registered interceptor names, in registration order. */
  static registered(): Array<string> {
    return this.interceptors.map((i) => i.name)
  }

  /**
   * Drop every interceptor. For tests that register one and must not leak it
   * into the next case; no production use.
   */
  static clear(): void {
    this.interceptors = []
  }

  /**
   * Collect per-request input from every module, merged.
   *
   * Returns `{}` when nothing is registered — so a core-only build calls this,
   * gets an empty object, and passes it straight through to `submitApproval`.
   */
  static async buildExtras(
    input: ApprovalExtrasInput,
  ): Promise<ApprovalExtras> {
    let merged: ApprovalExtras = {}
    for (const interceptor of this.interceptors) {
      const contributed = await interceptor.buildExtras?.(input)
      if (contributed) merged = { ...merged, ...contributed }
    }
    return merged
  }

  /** Run every `beforeVote`. The first to throw blocks the vote. */
  static async beforeVote(ctx: ApprovalContext): Promise<void> {
    for (const interceptor of this.interceptors) {
      await interceptor.beforeVote?.(ctx)
    }
  }

  /** Run every `afterVote` inside `tx`, merging what they return. */
  static async afterVote(
    voteId: string,
    ctx: ApprovalContext,
    tx: TransactionClient,
  ): Promise<ApprovalResultExtras> {
    let merged: ApprovalResultExtras = {}
    for (const interceptor of this.interceptors) {
      const contributed = await interceptor.afterVote?.(voteId, ctx, tx)
      if (contributed) merged = { ...merged, ...contributed }
    }
    return merged
  }
}
