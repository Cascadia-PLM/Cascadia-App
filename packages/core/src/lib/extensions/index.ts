// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The extensibility layer: one typed dispatch contract, three phases.
 *
 * - **`guard`** runs before an operation's own writes and can refuse it. It
 *   attaches to an operation (`item.create`), not a fact, because a fact cannot
 *   be vetoed — what a refusal refuses is the attempt.
 * - **`in-transaction`** runs inside the mutation's transaction, handed `tx`
 *   and the pending envelope. A throw rolls the mutation back.
 * - **`consumed`** runs after the fact committed, from the durable log, with an
 *   independent cursor per extension and at-least-once delivery.
 *
 * Code decides what runs; data decides whether. Handler bodies are TypeScript
 * in a compiled package — never source in a database row — and enablement is a
 * row, so an operator can switch a misbehaving extension off without a rebuild.
 *
 * This barrel is the in-repo surface. The *published* surface — what a module
 * package outside core may rely on — is `./public`, deliberately narrower.
 */

export { defineExtension, ExtensionRegistry } from './registry'
export {
  dispatchGuard,
  guardOrThrow,
  hasGuardExtensions,
  isInternalMachinery,
  dispatchInTransaction,
  describeExtensions,
  filterMatches,
  logRefusals,
  stampCausation,
  ExtensionAmplificationError,
  ExtensionDispatchError,
  ExtensionRefusedError,
  EXTENSION_HOP_CAP,
} from './dispatch'
export {
  disabledExtensionIds,
  extensionEnablementLoadCount,
  isExtensionEnabled,
  resetExtensionEnablementCache,
  EXTENSIONS_DISABLED_SETTING_KEY,
} from './enablement'
export { startAppEventConsumers } from './app-consumers'
export {
  registerCoreExtensions,
  resetCoreExtensionRegistration,
} from './core/register'
export {
  createWiChangeAlertExtension,
  registerWiChangeAlertExtension,
  WI_CHANGE_ALERT_EXTENSION_ID,
} from './core/wi-change-alerts'
export {
  createSupersededWatermarkExtension,
  registerSupersededWatermarkExtension,
  SUPERSEDED_WATERMARK_EXTENSION_ID,
} from './core/superseded-watermarks'
export type { WiChangeAlertOptions } from './core/wi-change-alerts'
export type { SupersededWatermarkOptions } from './core/superseded-watermarks'
export {
  asDomainEventConsumer,
  registeredEventConsumers,
  runConsumedExtensionOnce,
  runRegisteredEventConsumersOnce,
  startEventConsumerPolling,
} from './consumers'
export {
  createRabbitMqEventRelay,
  registerRabbitMqEventRelay,
  RABBITMQ_EVENT_RELAY_ID,
} from './relay-rabbitmq'
export type { RabbitMqEventRelayOptions } from './relay-rabbitmq'
// The webhook fan-out lives under `lib/events/webhooks` with the log it reads,
// and is re-exported here because it is registered like any other extension.
export {
  createWebhookDispatcher,
  registerWebhookDispatcher,
} from '@/lib/events/webhooks/dispatcher'
export type { WebhookDispatcherOptions } from '@/lib/events/webhooks/dispatcher'

export {
  APPROVAL_VOTE,
  GUARD_OPERATIONS,
  ITEM_CREATE,
  ITEM_DELETE,
  ITEM_UPDATE,
  LIFECYCLE_TRANSITION,
  orNull,
} from './operations'
export type {
  ApprovalVoteIntent,
  GuardOperation,
  ItemCreateIntent,
  ItemDeleteIntent,
  ItemUpdateIntent,
  LifecycleTransitionIntent,
} from './operations'

export { EVERY_EVENT } from './types'
export type {
  ConsumedExtension,
  ConsumedExtensionContext,
  EveryEvent,
  EveryEventConsumedExtension,
  Extension,
  ExtensionFilter,
  ExtensionPhase,
  ExtensionRefusal,
  ExtensionRefusalResult,
  ExtensionReadHandle,
  GuardExtension,
  GuardExtensionContext,
  InTransactionExtension,
  InTransactionExtensionContext,
  RegisteredExtension,
} from './types'
