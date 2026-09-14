// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

export const lifecycleTransitionedPayloadSchema = z.object({
  instanceId: z.string().uuid(),
  /** The item the lifecycle runs on (for ECOs, the change order item). */
  itemId: z.string().uuid(),
  /** The item's type, e.g. "ChangeOrder", "WorkOrder", "Issue". */
  itemType: z.string(),
  fromState: z.string(),
  toState: z.string(),
  /**
   * The target state's lifecycle flags, carried so a consumer can key on
   * "this ECO released" or "this work order completed" without knowing any
   * state's name — names are configuration, flags are semantics.
   */
  toStateIsFinal: z.boolean(),
  toStateFinalKind: z.string().nullable(),
  /**
   * Whether the transition left the initial state, and whether it arrived back
   * at it. Leaving it is how a consumer recognises a submission, and arriving
   * back a rework that supersedes the approvals already given — neither by
   * what the states are called.
   */
  fromStateIsInitial: z.boolean(),
  toStateIsInitial: z.boolean(),
  /** The transition's name, e.g. "Submit for Review". */
  action: z.string(),
  comments: z.string().nullish(),
})

export type LifecycleTransitionedPayload = z.infer<
  typeof lifecycleTransitionedPayloadSchema
>

/**
 * A lifecycle instance moved between states. Emitted in the transaction that
 * writes the item's new state and the `workflow_history` row, so the event
 * exists exactly when both do. The instance's compare-and-swap — the
 * concurrency interlock — is the first write of that same transaction, so a
 * transition that loses the race records nothing.
 */
export const LIFECYCLE_TRANSITIONED = defineDomainEvent({
  type: 'lifecycle.transitioned',
  schemaVersion: 1,
  description: 'A lifecycle instance transitioned between states',
  subjectType: 'item',
  payloadSchema: lifecycleTransitionedPayloadSchema,
})
