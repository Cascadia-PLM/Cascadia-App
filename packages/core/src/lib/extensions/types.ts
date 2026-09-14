// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { DbInstance, TransactionClient } from '@/lib/db'
import type {
  DomainEvent,
  DomainEventDefinition,
  PendingDomainEvent,
  PublishDomainEventInput,
} from '@/lib/events/types'
import type { GuardOperation } from './operations'

/**
 * What a guard reads through: the pooled connection when the caller holds
 * no transaction, the caller's transaction when it does. Both, because the
 * contract is 'before this operation's own writes' rather than 'outside a
 * transaction' — see `GuardExtensionContext.db`.
 */
export type ExtensionReadHandle = DbInstance | TransactionClient

/**
 * The three phases an extension can attach to, named for their relationship
 * to the commit rather than for their order.
 *
 * Deliberately not `before`/`after`: both already mean something else
 * reachable from a single lifecycle transition — `TransitionAction.executeOn`
 * and `TransitionExecutionOptions.beforeFinalize`/`afterFinalize` — and a
 * third incompatible meaning of "after" in a contract that cannot later be
 * renamed is exactly the ambiguity this layer removes.
 */
export type ExtensionPhase = 'guard' | 'in-transaction' | 'consumed'

/** Matches every event type. Only the `consumed` phase accepts it. */
export const EVERY_EVENT = '*' as const
export type EveryEvent = typeof EVERY_EVENT

/**
 * The payload fields a `when` filter may match on: the scalar ones.
 *
 * Arrays and nested objects are excluded because a filter over them is not
 * answerable by introspection — "what will run on a Part, in what phase, from
 * which package" has to be decidable by reading the registry, and a structural
 * match makes it a question only execution can answer.
 */
type ScalarKeys<TPayload> = {
  [K in keyof TPayload]-?: NonNullable<TPayload[K]> extends
    string | number | boolean
    ? K
    : never
}[keyof TPayload]

/**
 * A declarative match over a payload's scalar fields: equality, or one-of when
 * given an array. Every named field must match, and an omitted filter matches
 * every event of the type.
 *
 * No predicate functions, deliberately. A predicate makes introspection
 * unanswerable, and being able to answer what runs on what is the single
 * property neither reference model has.
 */
export type ExtensionFilter<TPayload> = {
  readonly [K in ScalarKeys<TPayload>]?:
    TPayload[K] | ReadonlyArray<TPayload[K]>
}

/**
 * What a `guard` handler receives: the typed intent, and a read handle.
 *
 * `db` is whatever handle the operation is running on — the pooled connection
 * when the caller holds none, the caller's transaction when it does (the
 * release passes `options.tx` into `ItemService.update` from inside its
 * serializable closure). A guard handed the pool while the caller holds a
 * transaction would read a connection that cannot see the work it is about to
 * refuse, so the contract is "before this operation's own writes", not
 * "outside any transaction".
 */
export interface GuardExtensionContext<
  TIntent extends Record<string, unknown>,
> {
  /** What the operation is about to do. */
  intent: TIntent
  /** Read handle for the operation in progress. Reads only — see `preview`. */
  db: ExtensionReadHandle
  /** The user the operation is running as; null for system machinery. */
  actorId: string | null
  /**
   * True when this is the read-path preview that drives the UI —
   * `getAvailableTransitions`, which evaluates guards to predict what
   * execution will decide, so that the interface never offers a transition
   * that then fails. **A `guard` handler must be side-effect-free** in either
   * case; this exists so one that needs to tell the difference can.
   */
  preview: boolean
}

/** How a `guard` handler refuses. Returning nothing allows the operation. */
export interface ExtensionRefusal {
  /** Shown to the user and carried into the typed 4xx. */
  reason: string
}

/**
 * What an `in-transaction` handler receives: the pending envelope and the
 * mutation's own transaction. A throw rolls the mutation back.
 *
 * There is no per-handler savepoint. The primitive exists one line away in
 * the consumer runtime; the omission is semantic, because a handler registered
 * in this phase is registered precisely because it must be atomic with the
 * fact. An extension that wants its failure isolated wants `consumed`.
 */
export interface InTransactionExtensionContext<
  TPayload extends Record<string, unknown>,
> {
  /** The fact as published, minus `seq` — assigned when the transaction commits. */
  event: PendingDomainEvent<TPayload>
  /** The mutation's transaction. A throw here rolls the mutation back. */
  tx: TransactionClient
}

/**
 * What a `consumed` handler receives: the committed envelope, a transaction of
 * the consumer run, and the run's abort signal. This is the durable phase —
 * delivery is at-least-once, so handlers must be idempotent.
 */
export interface ConsumedExtensionContext<
  TPayload extends Record<string, unknown>,
> {
  event: DomainEvent<TPayload>
  /** Wrapped in a per-event savepoint by the consumer runtime. */
  tx: TransactionClient
  /** Aborted when the handler exceeds its deadline. */
  signal: AbortSignal
  /**
   * Emit a new fact caused by this one, with the chain stamped and bounded.
   *
   * Re-entry is allowed: an extension that writes may legitimately cause the
   * same fact to be emitted again. What is not allowed is an unbounded chain,
   * and this is the only phase where one is possible — within a transaction
   * the transaction is the bound, but a `consumed` extension emitting a fact
   * it also consumes loops forever, past any in-process counter, because each
   * hop is a new transaction in a new process.
   *
   * So this stamps `causationId` from the event being handled, inherits its
   * `correlationId`, and refuses above `EXTENSION_HOP_CAP` — naming the chain,
   * which is what turns an extension-driven loop into something a person can
   * read. `publishDomainEvent` called directly is unbounded, which is exactly
   * why this exists.
   */
  emit: <TNext extends Record<string, unknown>>(
    definition: DomainEventDefinition<TNext>,
    input: Omit<
      PublishDomainEventInput<TNext>,
      'causationId' | 'correlationId'
    >,
  ) => Promise<PendingDomainEvent<TNext>>
}

/** Fields every extension carries, whatever its phase. */
interface ExtensionCommon {
  /**
   * Stable identity, `<area>.<purpose>` — e.g. `odoo.sync-released-design`.
   * For a `consumed` extension this also names its cursor row, so renaming one
   * means starting over from seq 0.
   */
  id: string
  description?: string
  /**
   * Whether this extension runs at all, combined with the operator's own
   * disabled-set row. Defaults to enabled.
   *
   * A **boolean** is the static case: a fact about this build that cannot
   * change while the process lives. A **predicate** is for a gate whose inputs
   * can move — a licence, or configuration an administrator may supply after
   * boot — and is evaluated per dispatch rather than captured at registration.
   *
   * Prefer the predicate whenever the answer is not a compile-time constant.
   * A captured boolean is indistinguishable from a live one until the day its
   * inputs move, and then it is silently stale: a consumer that was disabled at
   * boot stays disabled forever even after the configuration it was waiting for
   * arrives. That is the same shape as the enablement defect stage 3 fixed.
   *
   * Both forms **fail open** on an error, as the disabled-set lookup does: a
   * configuration lookup must never be able to stop a write.
   */
  enabled?: boolean | (() => boolean | Promise<boolean>)
  /**
   * Which package contributed it, for introspection. Set by the registrant —
   * core's own extensions leave it unset and read as `core`.
   */
  source?: string
}

/** The `guard` arm: binds to an operation, because a fact cannot be vetoed. */
export interface GuardExtension<
  TIntent extends Record<string, unknown> = Record<string, unknown>,
> extends ExtensionCommon {
  phase: 'guard'
  on: GuardOperation<TIntent>
  when?: ExtensionFilter<TIntent>
  handler: (
    ctx: GuardExtensionContext<TIntent>,
  ) => Promise<ExtensionRefusal | void> | ExtensionRefusal | void
}

/** The `in-transaction` arm: binds to a fact, and commits with it. */
export interface InTransactionExtension<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> extends ExtensionCommon {
  phase: 'in-transaction'
  on: DomainEventDefinition<TPayload>
  when?: ExtensionFilter<TPayload>
  handler: (ctx: InTransactionExtensionContext<TPayload>) => Promise<void>
}

/** The `consumed` arm: binds to a fact, and runs after it committed. */
export interface ConsumedExtension<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> extends ExtensionCommon {
  phase: 'consumed'
  on: DomainEventDefinition<TPayload>
  when?: ExtensionFilter<TPayload>
  handler: (ctx: ConsumedExtensionContext<TPayload>) => Promise<void>
  /**
   * Where this extension's cursor starts the first time it is created. Declare
   * `'head'` for anything registered after the log shipped — see
   * `DomainEventConsumer.startAt`. Defaults to `'origin'`, which replays
   * everything still retained.
   */
  startAt?: 'origin' | 'head'
  /** Events per batch; a full batch means there is more to drain. Default 100. */
  batchSize?: number
  /**
   * How long one invocation may run before it is aborted and counted a
   * failure. Default 30 s. A handler that hung would otherwise hold this
   * consumer's cursor row, and with it every later event, forever.
   */
  handlerTimeoutMs?: number
}

/**
 * The `consumed` arm for an extension that wants every fact rather than one.
 *
 * Separate from `ConsumedExtension` rather than a widening of it, because with
 * no single definition there is no payload type — so there is nothing for
 * `when` to filter on and the handler necessarily reads an untyped envelope.
 * Two first-party extensions need exactly this and neither is a special case:
 * the RabbitMQ relay forwards everything to a topic exchange, and the webhook
 * fan-out matches each event against subscriptions it reads at delivery time.
 */
export interface EveryEventConsumedExtension extends ExtensionCommon {
  phase: 'consumed'
  on: EveryEvent
  handler: (
    ctx: ConsumedExtensionContext<Record<string, unknown>>,
  ) => Promise<void>
  /** See `ConsumedExtension.startAt`. */
  startAt?: 'origin' | 'head'
  batchSize?: number
  handlerTimeoutMs?: number
}

/**
 * An extension, discriminated on `phase` so that choosing a phase is choosing
 * a contract rather than remembering a convention.
 *
 * Each arm is a plain interface with its own `on`, `when` and `handler`.
 * Nothing here is conditional on a type parameter and nothing is wrapped in
 * `Omit`, which is what lets `handler`'s parameter be contextually typed at
 * the call site — see the note in `signature.inference.ts` for the two shapes
 * that were measured and why the other one does not work.
 */
export type Extension<
  T extends Record<string, unknown> = Record<string, unknown>,
> =
  | GuardExtension<T>
  | InTransactionExtension<T>
  | ConsumedExtension<T>
  | EveryEventConsumedExtension

/**
 * An extension as the registry holds it: the payload type is gone, because a
 * heterogeneous collection cannot carry one. The dispatcher re-narrows by
 * phase and trusts the registration site's typing, which is the only place
 * the payload was ever knowable.
 */
export type RegisteredExtension = Extension<Record<string, unknown>>

/** One refusal, as the dispatcher reports it. */
export interface ExtensionRefusalResult {
  extensionId: string
  reason: string
}
