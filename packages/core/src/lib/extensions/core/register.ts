// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Core's own extensions, registered by `registerCoreExtensions()`.
 *
 * **That core registers here at all is the point.** The layer is not a
 * module-only seam bolted on for third parties — the product's own release
 * follow-ups go through it, on the same contract, with the same delivery
 * guarantees. An extension point core does not itself use is a guess about
 * what somebody else will need.
 *
 * The RabbitMQ relay is deliberately *not* here: it is registered by the jobs
 * worker instead, because a deployment without a broker should not register a
 * consumer that cannot connect.
 */

import { ExtensionRegistry } from '../registry'
import {
  SUPERSEDED_WATERMARK_EXTENSION_ID,
  registerSupersededWatermarkExtension,
} from './superseded-watermarks'
import {
  WI_CHANGE_ALERT_EXTENSION_ID,
  registerWiChangeAlertExtension,
} from './wi-change-alerts'

let done = false

/**
 * Register core's extensions. Idempotent — several entry points call it, and a
 * test suite may call it again after clearing the registry.
 */
export function registerCoreExtensions(): void {
  if (done) return
  // Each skipped when already registered, and the guard set last. Set first,
  // a throw from the first registration left the second missing for the life
  // of the process, with every later call returning early as though both were
  // in place; and a retry must complete the set rather than throw on the half
  // that did register.
  if (!ExtensionRegistry.get(WI_CHANGE_ALERT_EXTENSION_ID)) {
    registerWiChangeAlertExtension()
  }
  if (!ExtensionRegistry.get(SUPERSEDED_WATERMARK_EXTENSION_ID)) {
    registerSupersededWatermarkExtension()
  }
  done = true
}

/** Reset the once-guard. Tests only. */
export function resetCoreExtensionRegistration(): void {
  done = false
}
