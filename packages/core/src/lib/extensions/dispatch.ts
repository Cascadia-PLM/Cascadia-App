// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { sql } from 'drizzle-orm'
import { isExtensionEnabled } from './enablement'
import { ExtensionRegistry } from './registry'
import { EVERY_EVENT } from './types'
import type {
  ExtensionFilter,
  ExtensionPhase,
  ExtensionReadHandle,
  ExtensionRefusalResult,
  RegisteredExtension,
} from './types'
import type { GuardOperation } from './operations'
import type { TransactionClient } from '@/lib/db'
import type {
  DomainEvent,
  DomainEventDefinition,
  PendingDomainEvent,
} from '@/lib/events/types'
import { AppError, ErrorCode } from '@/lib/errors'
import { describeError } from '@/lib/errors/describe'
import { eventLogger } from '@/lib/logging/logger'

/**
 * How many times a fact may be re-caused by extensions before a publish is
 * refused.
 *
 * Within one transaction the bound is the transaction. Across transactions it
 * is not: a `consumed` extension that emits a fact it also consumes loops
 * forever, past any in-process counter, because each hop is a new transaction
 * in a new process.
 */
export const EXTENSION_HOP_CAP = 8

/**
 * An extension's failure, wrapped so the retry predicate cannot see inside it.
 *
 * **This is the single most important functional requirement in the stage.**
 * All three release closures run under
 * `withSerializableRetry(fn, 3, ['40001', '40P01', '23505'])`, so a handler
 * inside a release executes up to four times for one logical release.
 * Rollback makes a `tx`-only handler safe under that — but `23505` is in the
 * retry list, so an extension whose own unique-constraint violation escaped
 * would silently re-run the entire release closure and surface as a merge
 * failure naming the release rather than the extension.
 *
 * `pgErrorCode` (`lib/db/retry.ts`) walks the `cause` chain up to five levels
 * looking for a string `code`, so the original error is deliberately **not**
 * attached as `cause` — it rides `extensionError` instead, where nothing
 * unwraps it. And this class sets its own `code`, which that walk finds at
 * depth 0: `'EXTENSION_FAILED'` is in no retry list, so the closure is
 * abandoned after one attempt and the error names the extension that caused
 * it.
 *
 * **Deliberately not an `AppError`**, unlike `ExtensionRefusedError`. A
 * refusal is a considered answer meant for the caller; a throw is a broken
 * extension, and its message carries whatever the extension's own error said —
 * a driver error's SQL and parameters included — which the API error builder
 * returns verbatim for an `AppError`. So `handleApiError` answers this as a
 * generic 500 and logs the whole chain server-side, where the extension's name
 * and its error are both visible to the people who can fix it.
 */
export class ExtensionDispatchError extends Error {
  /**
   * Not `cause`. Naming it `cause` would put a pg error code back in the
   * retry predicate's path, which is the whole failure this class prevents.
   */
  readonly extensionError: unknown
  readonly extensionId: string
  readonly phase: ExtensionPhase
  /** Read by `pgErrorCode` at depth 0, and in no retry list. */
  readonly code = 'EXTENSION_FAILED'

  constructor(
    extensionId: string,
    phase: ExtensionPhase,
    extensionError: unknown,
  ) {
    super(
      `Extension "${extensionId}" failed during ${phase}: ${describeError(extensionError)}`,
    )
    this.name = 'ExtensionDispatchError'
    this.extensionId = extensionId
    this.phase = phase
    this.extensionError = extensionError
  }
}

/** The message a refusal carries to the caller: who refused, and why. */
function refusalMessage(
  operation: string,
  refusals: ReadonlyArray<ExtensionRefusalResult>,
): string {
  const first = refusals[0]
  return refusals.length === 1 && first
    ? `${operation} refused by "${first.extensionId}": ${first.reason}`
    : `${operation} refused by ${refusals.length} extensions: ` +
        refusals.map((r) => `${r.extensionId} (${r.reason})`).join('; ')
}

/**
 * Refused by a `guard` extension: HTTP 422 with code `EXTENSION_REFUSED`, and
 * the refusing extension and its reason in the message the caller sees.
 *
 * **An `AppError`, because the API error contract speaks only to those.**
 * `handleApiError` maps an `AppError` to its own status; anything else falls
 * through to the unknown-error branch and is answered as a 500 "An unexpected
 * error occurred", logged as a non-operational fault. This class first shipped
 * as a plain `Error` with a `status` field nothing read, so every refusal
 * reached the user as a server fault with its reason thrown away — the one
 * outcome a refusal exists to avoid.
 *
 * Its inherited `code` is a string at depth 0, which is also what keeps a
 * refusal out of `withSerializableRetry`: `EXTENSION_REFUSED` is in no retry
 * list, so a caller inside a retried closure is not re-run for a policy "no".
 */
export class ExtensionRefusedError extends AppError {
  readonly refusals: ReadonlyArray<ExtensionRefusalResult>
  readonly operation: string

  constructor(operation: string, refusals: Array<ExtensionRefusalResult>) {
    super(ErrorCode.EXTENSION_REFUSED, refusalMessage(operation, refusals), {
      context: { operation, refusals },
    })
    this.refusals = refusals
    this.operation = operation
  }
}

/** Raised when an extension-caused chain exceeds `EXTENSION_HOP_CAP`. */
export class ExtensionAmplificationError extends Error {
  readonly code = 'EXTENSION_AMPLIFICATION'

  constructor(type: string, depth: number, chain: ReadonlyArray<string>) {
    super(
      `Refusing to publish "${type}": it is hop ${depth} of an ` +
        `extension-caused chain, past the cap of ${EXTENSION_HOP_CAP}. ` +
        `Chain (newest first): ${chain.join(' <- ')}`,
    )
    this.name = 'ExtensionAmplificationError'
  }
}

/**
 * Whether a declarative filter matches a payload.
 *
 * Equality, or one-of when the filter value is an array. An absent filter
 * matches everything; a filter naming a field the payload does not carry does
 * not match, which is why `when` is typed against the payload at the
 * registration site — the compiler is what stops a filter that can never fire.
 */
export function filterMatches(
  filter: ExtensionFilter<Record<string, unknown>> | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true
  for (const [field, expected] of Object.entries(filter)) {
    if (expected === undefined) continue
    const actual = payload[field]
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false
    } else if (actual !== expected) {
      return false
    }
  }
  return true
}

/** The registered, enabled extensions for one phase and subject. */
async function eligible(
  phase: ExtensionPhase,
  subject: string,
): Promise<Array<RegisteredExtension>> {
  const candidates = ExtensionRegistry.forSubject(phase, subject)
  if (candidates.length === 0) return []
  const keep: Array<RegisteredExtension> = []
  for (const extension of candidates) {
    if (await isExtensionEnabled(extension)) keep.push(extension)
  }
  return keep
}

/**
 * Run the `guard` extensions for an operation, and report their refusals.
 *
 * Returns the refusals rather than throwing, because the two call-site styles
 * need different things: `ItemService` raises `ExtensionRefusedError` (a typed
 * 4xx, nothing written), while `LifecycleInstanceService.transition` folds a
 * refusal into `guardResults` as a synthetic entry — exactly as core already
 * does for the approval-requirement check — so the transition endpoint's
 * failure vocabulary is unchanged.
 *
 * **Zero registrations cost nothing.** The registry lookup is two map reads
 * and this returns before building a context or touching the database, so the
 * community edition does not pay for a feature it does not use.
 *
 * A handler that *throws* is a fault, not a refusal: it surfaces as
 * `ExtensionDispatchError`, which is distinguishable at the call site. A
 * refusal is a considered "no"; a fault is a broken extension, and conflating
 * them would let a bug read as policy.
 */
export async function dispatchGuard<TIntent extends Record<string, unknown>>(
  operation: GuardOperation<TIntent>,
  intent: TIntent,
  context: {
    db: ExtensionReadHandle
    actorId: string | null
    /** True on the read path that predicts what execution will decide. */
    preview?: boolean
  },
): Promise<Array<ExtensionRefusalResult>> {
  const extensions = await eligible('guard', operation.operation)
  if (extensions.length === 0) return []

  const refusals: Array<ExtensionRefusalResult> = []
  for (const extension of extensions) {
    if (extension.phase !== 'guard') continue
    if (!filterMatches(extension.when, intent)) continue
    let outcome
    try {
      outcome = await extension.handler({
        intent,
        db: context.db,
        actorId: context.actorId,
        preview: context.preview ?? false,
      })
    } catch (error) {
      throw new ExtensionDispatchError(extension.id, 'guard', error)
    }
    if (outcome && typeof outcome.reason === 'string') {
      refusals.push({ extensionId: extension.id, reason: outcome.reason })
    }
  }
  return refusals
}

/**
 * Run the `in-transaction` extensions for a fact, inside the transaction that
 * wrote it.
 *
 * Called from `publishDomainEvent` rather than from each emission site: one
 * call with the publish means the log cannot disagree with what a handler saw,
 * and no site can emit without dispatching. A rule per emission site would have
 * been one chance to forget per site, and the sites keep multiplying.
 *
 * A throw rolls the mutation back, wrapped so the surfaced error names the
 * extension and so the retry predicate leaves it alone — see
 * `ExtensionDispatchError`.
 */
export async function dispatchInTransaction<
  TPayload extends Record<string, unknown>,
>(
  tx: TransactionClient,
  definition: DomainEventDefinition<TPayload>,
  event: PendingDomainEvent<TPayload>,
): Promise<void> {
  if (!ExtensionRegistry.hasPhase('in-transaction')) return
  const extensions = await eligible('in-transaction', definition.type)
  if (extensions.length === 0) return

  for (const extension of extensions) {
    if (extension.phase !== 'in-transaction') continue
    if (!filterMatches(extension.when, event.payload)) continue
    try {
      await extension.handler({
        event: event,
        tx,
      })
    } catch (error) {
      throw new ExtensionDispatchError(extension.id, 'in-transaction', error)
    }
  }
}

/**
 * How deep an extension-caused chain this event sits in, and the chain itself.
 *
 * Walks `causation_id` in one recursive query, bounded by the cap so the walk
 * cannot become the amplification it is there to stop. Depth 0 is an event
 * nothing caused.
 *
 * **Why a walk and not a stored counter.** The plan's shape was a `hop_count`
 * column stamped from the parent's value, which is one column on
 * `domain_events` — and this stage adds no DDL at all, which is what makes
 * stage 6 a legitimate publish point. The chain is already in the table, so
 * the same bound is computable from data rather than duplicated beside it; and
 * the walk answers a question a counter cannot, which is *what* the chain was.
 * It is paid only when `causationId` is set, so an ordinary write — every
 * write that no extension caused — never runs it. If it ever shows up in a
 * profile, folding a `hop_count` column into the wave's unpublished migration
 * is the drop-in replacement.
 */
async function causationDepth(
  tx: ExtensionReadHandle,
  causationId: string,
): Promise<{ depth: number; chain: Array<string> }> {
  const rows = (await tx.execute(sql`
    WITH RECURSIVE chain AS (
      SELECT id, causation_id, type, 1 AS depth
        FROM domain_events
       WHERE id = ${causationId}
      UNION ALL
      SELECT e.id, e.causation_id, e.type, c.depth + 1
        FROM domain_events e
        JOIN chain c ON e.id = c.causation_id
       WHERE c.depth <= ${EXTENSION_HOP_CAP}
    )
    SELECT type, depth FROM chain ORDER BY depth ASC
  `)) as unknown as Array<{ type: string; depth: number }>

  return {
    depth: rows.length,
    chain: rows.map((row) => row.type),
  }
}

/**
 * Stamp and bound a fact an extension is causing.
 *
 * Returns the `causationId`, `correlationId` and nothing else: the caller
 * publishes. Refuses above the cap, naming the chain, because the failure this
 * prevents — a `consumed` extension emitting a fact it also consumes — is
 * otherwise an infinite loop that no in-process counter can see, each hop
 * being a new transaction in a new process.
 */
export async function stampCausation(
  tx: ExtensionReadHandle,
  type: string,
  triggering: Pick<DomainEvent, 'id' | 'correlationId'>,
): Promise<{ causationId: string; correlationId: string | undefined }> {
  const { depth, chain } = await causationDepth(tx, triggering.id)
  if (depth >= EXTENSION_HOP_CAP) {
    throw new ExtensionAmplificationError(type, depth + 1, [type, ...chain])
  }
  return {
    causationId: triggering.id,
    correlationId: triggering.correlationId ?? undefined,
  }
}

/**
 * Whether any guard extension is registered for an operation.
 *
 * For call sites whose *intent* costs a query to assemble — the lifecycle
 * transition needs the item's type, which it does not otherwise load before
 * the write. Checking first keeps the promise that zero registrations cost
 * zero queries, which is the difference between a feature the community
 * edition ignores and one it pays for.
 */
export function hasGuardExtensions(operation: { operation: string }): boolean {
  return ExtensionRegistry.forSubject('guard', operation.operation).length > 0
}

/**
 * Whether this caller is core's own release machinery rather than a user.
 *
 * **A release dispatches no guards.** The release calls `ItemService.update`
 * and its siblings with `allowLifecycleFields`, `bypassBranchProtection` and
 * `skipAccessCheck`, whose doc comments already reserve them for exactly that
 * caller; extension dispatch joins that set. Three reasons, and the first is
 * sufficient on its own:
 *
 * - One badly written rule would otherwise brick every release in a plant. A
 *   guard exists to refuse a person's attempt, and by release time the attempt
 *   was approved — the decision has already been made, on the change order.
 * - A refusal inside `withSerializableRetry`'s closure aborts a partially
 *   written release rather than refusing cleanly; there is no "nothing was
 *   written" to return to.
 * - Design-engine materialisation, the importer and the demo seed all drive
 *   these services directly and need a sanctioned way to run.
 *
 * The consequence is worth stating plainly: a rule that must hold at release
 * time belongs in `in-transaction` or `consumed`, not in `guard`.
 */
export function isInternalMachinery(options?: {
  allowLifecycleFields?: boolean
  bypassBranchProtection?: boolean
  skipAccessCheck?: boolean
}): boolean {
  return (
    options?.allowLifecycleFields === true ||
    options?.bypassBranchProtection === true ||
    options?.skipAccessCheck === true
  )
}

/**
 * Run the guards for an operation and throw a typed 4xx if any refuses.
 *
 * The shape most call sites want: `ItemService` has no `guardResults` to fold
 * a refusal into, so a refusal is an error and nothing was written.
 */
export async function guardOrThrow<TIntent extends Record<string, unknown>>(
  operation: GuardOperation<TIntent>,
  intent: TIntent,
  context: {
    db: ExtensionReadHandle
    actorId: string | null
    preview?: boolean
  },
): Promise<void> {
  const refusals = await dispatchGuard(operation, intent, context)
  if (refusals.length === 0) return
  logRefusals(operation.operation, refusals)
  throw new ExtensionRefusedError(operation.operation, refusals)
}

/**
 * Every extension that would run for a subject, for the introspection route.
 * Reads the registry only — no enablement query, because the route reports what
 * is registered and says separately whether it is switched off.
 */
export function describeExtensions(subject?: string): Array<{
  id: string
  phase: ExtensionPhase
  on: string
  when: Record<string, unknown> | null
  source: string
  description: string | null
}> {
  const all = ExtensionRegistry.list()
  return all
    .filter((extension) => {
      if (!subject) return true
      if (extension.phase === 'guard') return extension.on.operation === subject
      if (extension.on === EVERY_EVENT) return true
      return extension.on.type === subject
    })
    .map((extension) => ({
      id: extension.id,
      phase: extension.phase,
      on:
        extension.phase === 'guard'
          ? extension.on.operation
          : extension.on === EVERY_EVENT
            ? EVERY_EVENT
            : extension.on.type,
      when:
        extension.phase === 'guard' || extension.on !== EVERY_EVENT
          ? (extension.when ?? null)
          : null,
      source: extension.source ?? 'core',
      description: extension.description ?? null,
    }))
}

/**
 * Log a refusal at info level. Nothing durable records a refusal — a refused
 * operation changed nothing — so this line is where an operator asked why a
 * write was rejected finds the answer. Only an enforced refusal is logged; a
 * transition preview asking what would be refused is not.
 */
export function logRefusals(
  operation: string,
  refusals: ReadonlyArray<ExtensionRefusalResult>,
): void {
  if (refusals.length === 0) return
  eventLogger.info({ operation, refusals }, 'Operation refused by extensions')
}
