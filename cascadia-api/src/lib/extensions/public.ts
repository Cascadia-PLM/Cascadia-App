// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The published extension surface: `@cascadia/api/extensions`.
 *
 * This is what a package outside `cascadia-api` may rely on. It ships now
 * rather than with a future customer story because "public" is otherwise a
 * habit rather than a boundary, and every later attempt to draw the line
 * becomes a breaking change against whatever module authors reached for in the
 * meantime.
 *
 * **What it does not do.** Exporting this file does not by itself make a
 * third-party extension package possible. That additionally needs a stability
 * promise this repository has not made, a registration point outside this
 * repository, and the licensing question the architecture document escalates —
 * an extension is a derived work of an AGPL core, which is a decision for a
 * human, not a file. Today's consumers are first-party module packages, and
 * this file is the seam they go through so that the seam is real before anyone
 * depends on it.
 *
 * Deliberately **not** exported: the registry's mutation surface beyond
 * `defineExtension` (`ExtensionRegistry.clear` is a test affordance),
 * everything under `dispatch.ts` except the error classes an extension can
 * legitimately catch, the enablement cache internals, and the consumer runtime.
 * A module contributes behaviour; it does not drive the layer.
 */

// The one way to register anything.
export { defineExtension } from './registry'

// The five operations a guard may attach to, and their intent types.
export {
  APPROVAL_VOTE,
  ITEM_CREATE,
  ITEM_DELETE,
  ITEM_UPDATE,
  LIFECYCLE_TRANSITION,
} from './operations'
export type {
  ApprovalVoteIntent,
  GuardOperation,
  ItemCreateIntent,
  ItemDeleteIntent,
  ItemUpdateIntent,
  LifecycleTransitionIntent,
} from './operations'

// The wildcard a `consumed` extension may subscribe with.
export { EVERY_EVENT } from './types'

// The phase context types, so a handler can be written as a named function
// rather than only inline.
export type {
  ConsumedExtension,
  ConsumedExtensionContext,
  EveryEvent,
  EveryEventConsumedExtension,
  Extension,
  ExtensionFilter,
  ExtensionPhase,
  ExtensionReadHandle,
  ExtensionRefusal,
  GuardExtension,
  GuardExtensionContext,
  InTransactionExtension,
  InTransactionExtensionContext,
} from './types'

// The errors an extension author will see, and may catch.
export {
  ExtensionAmplificationError,
  ExtensionDispatchError,
  ExtensionRefusedError,
} from './dispatch'
