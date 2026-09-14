// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Domain events: a durable, ordered log of business facts.
 *
 * - `publishDomainEvent(tx, DEFINITION, {...})` appends inside the caller's
 *   transaction (transactional outbox) — the event exists iff the change
 *   committed. `seq` is assigned at commit by a trigger
 *   (`ensureDomainEventSequencing`), so seq order is commit order.
 * - Consumers are `consumed` extensions (`defineExtension` in
 *   `lib/extensions`), each reading the log through its own cursor:
 *   at-least-once, in order, Postgres only.
 * - The RabbitMQ relay is one consumer among several — the webhook
 *   dispatcher, core's release follow-ups and module connectors are others.
 *
 * Design and rationale: docs/features/extensibility.md
 */

// Registers the core event catalog as a side effect.
import './definitions/register'

export type {
  ConsumerRunResult,
  DomainEvent,
  DomainEventConsumer,
  DomainEventDefinition,
  EventConsumerContext,
  PendingDomainEvent,
  PublishDomainEventInput,
} from './types'
export { EventTypeRegistry } from './registry'
export {
  defineDomainEvent,
  isDomainEventOfType,
  publishDomainEvent,
  rowToDomainEvent,
} from './publish'
export {
  DOMAIN_EVENT_SEQ_LOCK_KEY,
  DOMAIN_EVENT_SEQ_TRIGGER,
  DOMAIN_EVENT_SEQUENCING_SQL,
  ensureDomainEventSequencing,
  sequenceUnsequencedEvents,
} from './sequencing'
// Running one consumer. Which consumers exist, and the polling that drives
// them, belong to `lib/extensions` — `defineExtension` with
// `phase: 'consumed'` is the only way to register one.
export {
  DEFAULT_ABANDON_AFTER_DAYS,
  abandonLongParkedConsumers,
  computeRetentionHorizon,
  countUnsequencedEvents,
  forgetEventConsumer,
  pruneDomainEvents,
  type PruneResult,
  type RetentionHorizon,
} from './retention'
export {
  EventHandlerTimeoutError,
  TransientConsumerError,
  drainEventConsumer,
  isTransientConsumerFailure,
  resumeEventConsumer,
  runEventConsumerOnce,
  skipPoisonEvent,
} from './consumers'
export {
  RELATIONSHIP_ADDED,
  RELATIONSHIP_REMOVED,
  RELATIONSHIP_UPDATED,
  relationshipAddedPayloadSchema,
  relationshipRemovedPayloadSchema,
  relationshipUpdatedPayloadSchema,
  type RelationshipAddedPayload,
  type RelationshipRemovedPayload,
  type RelationshipUpdatedPayload,
} from './definitions/relationships'
export {
  WORK_ORDER_RUN_COMPLETED,
  WORK_ORDER_SIGN_OFF_SUBMITTED,
  workOrderRunCompletedPayloadSchema,
  workOrderSignOffSubmittedPayloadSchema,
  type WorkOrderRunCompletedPayload,
  type WorkOrderSignOffSubmittedPayload,
} from './definitions/work-orders'
export {
  DESIGN_CREATED,
  PROGRAM_CREATED,
  designCreatedPayloadSchema,
  programCreatedPayloadSchema,
  type DesignCreatedPayload,
  type ProgramCreatedPayload,
} from './definitions/hierarchy'
export {
  CHANGE_ORDER_CANCELLED,
  CHANGE_ORDER_RELEASED,
  DESIGN_RELEASED,
  changeOrderCancelledPayloadSchema,
  changeOrderReleasedPayloadSchema,
  designReleasedPayloadSchema,
  type ChangeOrderCancelledPayload,
  type ChangeOrderReleasedPayload,
  type DesignReleasedPayload,
} from './definitions/change-orders'
export {
  ITEM_DELETED,
  ITEM_OBSOLETED,
  ITEM_UPDATED,
  itemDeletedPayloadSchema,
  itemObsoletedPayloadSchema,
  itemUpdatedPayloadSchema,
  type ItemDeletedPayload,
  type ItemObsoletedPayload,
  type ItemUpdatedPayload,
} from './definitions/item-edits'
export {
  ITEM_CHECKED_IN,
  ITEM_CHECKED_OUT,
  ITEM_CHECKOUT_CANCELLED,
  checkoutPayloadSchema,
  type CheckoutPayload,
} from './definitions/checkouts'
export {
  FILE_CHECKED_IN,
  FILE_DELETED,
  FILE_RESTORED,
  FILE_UPLOADED,
  filePayloadSchema,
  type FilePayload,
} from './definitions/files'
export {
  BRANCH_ARCHIVED,
  BRANCH_CREATED,
  branchPayloadSchema,
  type BranchPayload,
} from './definitions/branches'
export {
  APPROVAL_VOTED,
  approvalVotedPayloadSchema,
  type ApprovalVotedPayload,
} from './definitions/approvals'
export {
  ITEM_CREATED,
  ITEM_RELEASED,
  itemCreatedPayloadSchema,
  itemReleasedPayloadSchema,
  type ItemCreatedPayload,
  type ItemReleasedPayload,
} from './definitions/items'
export {
  LIFECYCLE_TRANSITIONED,
  lifecycleTransitionedPayloadSchema,
  type LifecycleTransitionedPayload,
} from './definitions/lifecycles'
