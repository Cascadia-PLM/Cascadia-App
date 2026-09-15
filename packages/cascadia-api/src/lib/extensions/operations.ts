// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The operations a `guard` extension can attach to.
 *
 * A fact cannot be vetoed — `item.released` reports that an item released, and
 * by the time it exists the row is committed and the caller has been told it
 * worked. What a refusal refuses is the *attempt*. So `guard` binds to an
 * operation (`item.create`) while `in-transaction` and `consumed` bind to a
 * fact (`item.created`), and the two vocabularies are deliberately distinct.
 *
 * **There is no operation registry and no Zod schema per site.** These five
 * are a closed set of exported constants, and the type system is what
 * validates a registration: `on` must *be* one of these objects, so an
 * extension naming an operation that does not exist does not compile. That is
 * strictly stronger than the runtime catalog check the fact phases need, and
 * it is why this file has no `register()`.
 *
 * The intent types are hand-written rather than derived from the fact
 * payloads, because a pre-write region genuinely knows less: no id has been
 * assigned, no number generated, no revision minted. Typing a guard with the
 * fact's payload would promise fields that cannot exist yet.
 *
 * Growing this set is a deliberate act. A site qualifies only where core has a
 * real pre-write region — the ones that do not are named in the architecture
 * document (`ItemService.revise` opens its transaction on the first line;
 * `FileService.uploadFile` writes vault bytes before any database work, so a
 * late refusal leaks a blob rather than refusing anything).
 */

import type { ChangeAction } from '@cascadia/commons/lib/types/lifecycle'

/**
 * A guard-able operation. `TIntent` is carried phantom-wise: there is nothing
 * to validate at runtime, because the intent is built in-process by core
 * rather than parsed off the wire, so the type exists only to flow into
 * `when` and the handler at the `defineExtension` call site.
 *
 * The intent types below are **type aliases, not interfaces**, and that is
 * load-bearing rather than stylistic. Writing them as
 * `interface X extends Record<string, unknown>` satisfies the same constraint
 * but gives each one a string index signature, which `ExtensionFilter` then
 * inherits — and a filter type with an index signature accepts every key, so
 * `when: { nosuchfield: 'Part' }` compiles and the guard silently never
 * matches. A type alias satisfies `Record<string, unknown>` structurally
 * without gaining the index signature. `signature.inference.ts` is what
 * caught this and is what keeps it caught.
 */
export interface GuardOperation<
  TIntent extends Record<string, unknown> = Record<string, unknown>,
> {
  /** `<entity>.<verb>`, present tense — the attempt, not the fact. */
  operation: string
  description: string
  /**
   * Phantom. Never set, never read, never present at runtime — it exists so
   * that `TIntent` is inferable from the value, which is what makes
   * `defineExtension(… on: ITEM_CREATE …)` type its handler.
   */
  readonly __intent?: TIntent
}

/** Declare a guard-able operation. Adds nothing to any registry — see above. */
function defineGuardOperation<TIntent extends Record<string, unknown>>(
  operation: Omit<GuardOperation<TIntent>, '__intent'>,
): GuardOperation<TIntent> {
  return operation
}

/**
 * What `ItemService.create` knows before `NumberingService.generate` runs.
 *
 * `itemNumber` is optional precisely because of where this site sits: the
 * number is generated *after* the guard, on `autonomousDb`, which commits
 * independently — so a refusal placed after it would burn a number nothing
 * reclaims. A guard that needs the number cannot have one, by construction.
 */
export type ItemCreateIntent = {
  itemType: string
  designId: string | null
  /** Caller-supplied; absent when the number is about to be generated. */
  itemNumber: string | null
  name: string | null
  /** The type schema's parsed output, for a rule that keys on a typed field. */
  data: Record<string, unknown>
}

export const ITEM_CREATE = defineGuardOperation<ItemCreateIntent>({
  operation: 'item.create',
  description: 'A new item master is about to be created',
})

/**
 * Where an item's lifecycle state sits, as the flags a rule keys on.
 *
 * The flags ride beside the state's id rather than the id riding alone,
 * because an id alone invites `when: { stateId: 'Released' }` — the literal
 * comparison this codebase forbids everywhere else. State ids and names are
 * both administrator configuration; "released", "initial" and "final" are
 * semantics, and they are what a rule should mean.
 */
export type LifecyclePositionFields = {
  /** The state's id. For message text and correlation — **not** for keying on. */
  stateId: string
  /** The state is its lifecycle's initial state. */
  stateIsInitial: boolean
  /** The state is in the released family: released, revised, obsolete or superseded. */
  stateIsReleased: boolean
  /** The state is final for its lifecycle. */
  stateIsFinal: boolean
  /** What finishing there means, when the state is final and declares it. */
  stateFinalKind: 'release' | 'cancel' | 'complete' | null
}

/**
 * What an item edit knows once its access and editability checks pass — from
 * `ItemService.update`, or from `CheckoutService.saveChanges` for an edit on a
 * change-order branch, which is where the first save of a checked-out item
 * goes.
 */
export type ItemUpdateIntent = LifecyclePositionFields & {
  itemId: string
  masterId: string
  itemType: string
  designId: string | null
  itemNumber: string | null
  revision: string
  /** Field names the caller is attempting to change. */
  changedFields: ReadonlyArray<string>
  /** The caller's partial input, for a rule that keys on a specific value. */
  changes: Record<string, unknown>
}

export const ITEM_UPDATE = defineGuardOperation<ItemUpdateIntent>({
  operation: 'item.update',
  description: "An item's fields are about to be changed",
})

/** What `ItemService.delete` knows after `requireNoRetainedEvidence`. */
export type ItemDeleteIntent = LifecyclePositionFields & {
  itemId: string
  masterId: string
  itemType: string
  designId: string | null
  itemNumber: string | null
  revision: string
}

export const ITEM_DELETE = defineGuardOperation<ItemDeleteIntent>({
  operation: 'item.delete',
  description: 'An item row is about to be hard-deleted',
})

/**
 * What `LifecycleInstanceService.transition` knows once its own guards have
 * passed.
 *
 * `fromState` and `toState` are state **ids**, not names: names are
 * administrator-editable configuration and a rule keyed on one breaks when
 * somebody renames a state.
 */
export type LifecycleTransitionIntent = {
  instanceId: string
  itemId: string
  itemType: string
  fromState: string
  toState: string
  /** The target state's flags — semantics, where the names are configuration. */
  toStateIsFinal: boolean
  toStateFinalKind: string | null
  transitionId: string
  /** Administrator-editable; present for message text, not for keying on. */
  transitionName: string
  comments: string | null
}

export const LIFECYCLE_TRANSITION =
  defineGuardOperation<LifecycleTransitionIntent>({
    operation: 'lifecycle.transition',
    description: 'A lifecycle instance is about to move between states',
  })

/** What `ApprovalService.submitApproval` knows before the vote is written. */
export type ApprovalVoteIntent = {
  instanceId: string
  itemId: string
  stateId: string
  userId: string
  vote: string
  roleId: string | null
  roleName: string | null
  comments: string | null
}

export const APPROVAL_VOTE = defineGuardOperation<ApprovalVoteIntent>({
  operation: 'approval.vote',
  description: 'An approver is about to record a vote',
})

/**
 * The change action a release is about to apply. Not a guard site in this
 * wave — the release deliberately dispatches no guards at all (see
 * `dispatch.ts`) — and named here only so the type is not invented twice if
 * that decision is ever revisited.
 */
export type GuardableChangeAction = ChangeAction

/**
 * Normalise an absent value to `null` for an intent field.
 *
 * A guard site reads fields whose optionality three tsconfigs in this
 * repository disagree about: `packages/cascadia-api`'s own project sees
 * `BaseItem.designId` as non-nullable, the app projects see
 * `string | undefined`. Writing `?? null` inline therefore fails one gate or
 * the other — ESLint calls it an unnecessary condition under one config while
 * `tsc` requires it under another. Inside a generic the value is genuinely
 * nullable, so both are satisfied and neither needs a suppression.
 */
export function orNull<T>(value: T | null | undefined): T | null {
  return value ?? null
}

/**
 * Every guard-able operation, for introspection.
 *
 * Typed to the wire fields rather than to `GuardOperation<T>`: the phantom
 * intent parameter makes the five types mutually unassignable, which is
 * correct at a registration site and useless in a list nobody dispatches from.
 */
export const GUARD_OPERATIONS: ReadonlyArray<{
  operation: string
  description: string
}> = [
  ITEM_CREATE,
  ITEM_UPDATE,
  ITEM_DELETE,
  LIFECYCLE_TRANSITION,
  APPROVAL_VOTE,
]
