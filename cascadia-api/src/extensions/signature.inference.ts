// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Compile-time proof that `defineExtension` types what it claims to type.
 *
 * There is no runtime assertion here and there is not meant to be: this file is
 * inside `cascadia-api`'s tsc project, so `npm run typecheck` is the
 * assertion. Task 4.1 required the signature to be prototyped rather than
 * sketched, because a signature that infers nothing leaves the layer's one
 * genuine differentiator undelivered while looking finished — and no
 * behavioural test can notice a payload type failing to flow into a handler.
 *
 * Positive cases assert the inference. Negative cases carry `@ts-expect-error`,
 * so this file also fails if one of them *stops* being an error, which is the
 * direction a hand-written type test usually misses.
 *
 * **What was measured, and where the plan was wrong.** A single generic call
 * over a `phase`-discriminated union works: the payload or intent type is
 * inferred from `on`, and the `phase` literal selects the arm that contextually
 * types `handler`'s parameter. The curried `defineExtension(DEFINITION)({ … })`
 * the plan recommended instead does **not**, for a reason worth recording: its
 * second argument has to be spelled `Omit<Extension<T>, 'on'>`, `Omit` is built
 * on `keyof`, and `keyof` over a union yields the *intersection* of its
 * members' keys — so `Omit` collapses the discriminated union into one
 * undiscriminated object and `ctx` lands as an implicit `any`. The plan's
 * warning about conditional types in parameter position was right; its proposed
 * remedy reintroduced the same failure by another route.
 */

import { ITEM_CREATE, LIFECYCLE_TRANSITION } from './operations'
import { EVERY_EVENT } from './types'
import type { defineExtension } from './registry'
import type { DesignReleasedPayload, ItemCreatedPayload } from '@/lib/events'
import type { ItemCreateIntent } from './operations'
import type {
  ExtensionFilter,
  GuardExtension,
  InTransactionExtension,
} from './types'
import {
  DESIGN_RELEASED,
  ITEM_CREATED,
  LIFECYCLE_TRANSITIONED,
} from '@/lib/events'

/**
 * Every probe, inside a function nothing calls.
 *
 * `defineExtension` registers what it is handed, so a probe at module scope
 * would register a live extension — among them a guard refusing Part creation
 * — in any process that imported this file. Nothing did, which kept that safe
 * by absence only. The type checker reads a function body whether or not it
 * runs, so every assertion below holds exactly as it did, and nothing is ever
 * registered. `defineExtension` is imported as a type for the same reason.
 */
export function inferenceProbes(define: typeof defineExtension) {
  /* ---------------------------------------------------------------- *
   * Positive — the type flows into `when` and into each phase's handler
   * ---------------------------------------------------------------- */

  /** `guard` binds to an operation, and receives that operation's intent. */
  const guardOnCreate = define({
    id: 'inference.guard-create',
    on: ITEM_CREATE,
    phase: 'guard',
    when: { itemType: 'Part' },
    handler: (ctx) => {
      const itemType: string = ctx.intent.itemType
      const designId: string | null = ctx.intent.designId
      const preview: boolean = ctx.preview
      const actorId: string | null = ctx.actorId
      void designId
      void actorId
      return itemType === 'Part' && !preview
        ? { reason: 'no parts today' }
        : undefined
    },
  })

  /** A guard may also match one-of, and read the state flags on a transition. */
  const guardOnTransition = define({
    id: 'inference.guard-transition',
    on: LIFECYCLE_TRANSITION,
    phase: 'guard',
    when: { toStateFinalKind: ['release', 'complete'] },
    handler: async (ctx) => {
      const isFinal: boolean = ctx.intent.toStateIsFinal
      const from: string = ctx.intent.fromState
      void isFinal
      void from
      await Promise.resolve()
    },
  })

  /** `in-transaction` binds to a fact, and receives the pending envelope. */
  const inTransactionOnCreated = define({
    id: 'inference.in-transaction-created',
    on: ITEM_CREATED,
    phase: 'in-transaction',
    when: { itemType: 'Part' },
    handler: async (ctx) => {
      const itemNumber: string = ctx.event.payload.itemNumber
      const id: string = ctx.event.id
      void itemNumber
      void id
      await Promise.resolve()
    },
  })

  /** `consumed` receives the committed envelope, with a seq and a bounded emit. */
  const consumedOnTransitioned = define({
    id: 'inference.consumed-transitioned',
    on: LIFECYCLE_TRANSITIONED,
    phase: 'consumed',
    when: { toStateFinalKind: ['release', 'complete'] },
    handler: async (ctx) => {
      const kind: string | null = ctx.event.payload.toStateFinalKind
      const seq: number = ctx.event.seq
      void kind
      void seq
      // `emit` is typed against the definition it is handed, not the one being
      // consumed — a caused fact is a different fact.
      await ctx.emit(ITEM_CREATED, {
        payload: {
          itemId: ctx.event.payload.itemId,
          masterId: ctx.event.payload.itemId,
          itemType: ctx.event.payload.itemType,
          itemNumber: 'X',
          name: null,
          designId: null,
          state: ctx.event.payload.toState,
          revision: '-',
        },
      })
    },
  })

  /** A scalar field of a payload that also has non-scalar fields is filterable. */
  const consumedOnReleased = define({
    id: 'inference.consumed-released',
    on: DESIGN_RELEASED,
    phase: 'consumed',
    when: { changeOrderLabel: 'ECO-000042 (ECO)' },
    handler: async (ctx) => {
      const label: string = ctx.event.payload.changeOrderLabel
      const first = ctx.event.payload.items[0]
      void label
      void first?.previousItemId
      await Promise.resolve()
    },
  })

  /** The wildcard arm: every fact, an untyped payload, and no `when`. */
  const relayLike = define({
    id: 'inference.every-event',
    on: EVERY_EVENT,
    phase: 'consumed',
    handler: async (ctx) => {
      const type: string = ctx.event.type
      void type
      await Promise.resolve()
    },
  })

  /* ---------------------------------------------------------------- *
   * Negative — each of these MUST be an error
   * ---------------------------------------------------------------- */

  /*
   * Filter typing is asserted against `ExtensionFilter<T>` directly rather than
   * through a `define` call. Overload resolution reports a failed call once per
   * mismatched property, and `@ts-expect-error` suppresses only the line after
   * it — so a call-level probe here would need several directives and would
   * break whenever a diagnostic moved. This asserts the same property, on the
   * line that owns it.
   */

  const filterRejectsUnknownField: ExtensionFilter<ItemCreateIntent> = {
    // @ts-expect-error `nosuchfield` is not a field of ItemCreateIntent
    nosuchfield: 'Part',
  }

  const filterRejectsWrongValueType: ExtensionFilter<ItemCreateIntent> = {
    // @ts-expect-error itemType is a string, not a number
    itemType: 42,
  }

  const filterRejectsNonScalarField: ExtensionFilter<DesignReleasedPayload> = {
    // @ts-expect-error `items` is an array, so it is not a filterable field
    items: [],
  }

  /** ...while the scalar fields of the same payload are accepted. */
  const filterAcceptsScalars: ExtensionFilter<DesignReleasedPayload> = {
    changeOrderLabel: 'ECO-000042 (ECO)',
    designId: ['a', 'b'],
  }

  /* A handler's context is fixed by its phase. */

  define({
    id: 'inference.bad-payload-field',
    on: ITEM_CREATED,
    phase: 'in-transaction',
    handler: async (ctx) => {
      // @ts-expect-error `notAField` is not on ItemCreatedPayload
      const x: unknown = ctx.event.payload.notAField
      void x
      await Promise.resolve()
    },
  })

  define({
    id: 'inference.wrong-phase-context',
    on: ITEM_CREATED,
    phase: 'in-transaction',
    handler: async (ctx) => {
      // @ts-expect-error `intent` belongs to the guard context, not this one
      const x: unknown = ctx.intent
      void x
      await Promise.resolve()
    },
  })

  define({
    id: 'inference.guard-has-no-event',
    on: ITEM_CREATE,
    phase: 'guard',
    handler: (ctx) => {
      // @ts-expect-error a guard sees an intent, not a published event
      const x: unknown = ctx.event
      void x
      return undefined
    },
  })

  /*
   * Phase and subject must agree. Asserted on `on` directly, for the same reason
   * the filters are: a failed overload resolution reports once per mismatched
   * property, and a directive only suppresses the following line.
   */

  // A guard cannot attach to a fact: `item.created` has already happened, and
  // what a refusal refuses is the attempt.
  // @ts-expect-error a fact definition is not a guard operation
  const guardCannotBindAFact: GuardExtension<ItemCreateIntent>['on'] =
    ITEM_CREATED

  // ...and a fact phase cannot attach to an operation.
  // @ts-expect-error an operation is not a fact definition
  const factPhaseCannotBindAnOperation: InTransactionExtension<ItemCreatedPayload>['on'] =
    ITEM_CREATE

  // The wildcard is only legal in `consumed`: there is no untyped intent to hand
  // a guard.
  // @ts-expect-error EVERY_EVENT is not a guard operation
  const guardCannotBeWildcard: GuardExtension<ItemCreateIntent>['on'] =
    EVERY_EVENT

  // A `consumed` handler may not refuse — only a guard can.
  define({
    id: 'inference.consumed-cannot-refuse',
    on: ITEM_CREATED,
    phase: 'consumed',
    // @ts-expect-error a consumed handler returns Promise<void>
    handler: () => Promise.resolve({ reason: 'no' }),
  })

  return [
    filterRejectsUnknownField,
    filterRejectsWrongValueType,
    filterRejectsNonScalarField,
    filterAcceptsScalars,
    guardCannotBindAFact,
    factPhaseCannotBindAnOperation,
    guardCannotBeWildcard,
    guardOnCreate,
    guardOnTransition,
    inTransactionOnCreated,
    consumedOnTransitioned,
    consumedOnReleased,
    relayLike,
  ]
}
