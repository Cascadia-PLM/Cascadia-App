// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Item Type Registration
 *
 * Registers every item type's code definition. Importing this module is all
 * it does; loading the runtime configuration that overrides it is the
 * caller's, because it reads the database and the answer is worth waiting
 * for. Each composition root — the HTTP entry points and `runJobsWorker()` —
 * awaits `ItemTypeRegistry.initialize()`.
 *
 * It used to fire that load and forget it, which meant the server answered
 * requests against code defaults for the length of one query, and a load that
 * failed was logged as a success.
 *
 * The `.server` in the name is now only history: there was a `.tsx` sibling
 * that registered the same definitions with React components attached, but
 * no entry point, router or component ever imported it, and nothing ever read
 * the components. The browser's item-type map is `item-type-ui.ts`.
 */

import { ITEM_TYPE_DEFINITIONS } from '@cascadia/commons/lib/items/item-type-definitions'
import { ItemTypeRegistry } from './registry'

for (const def of Object.values(ITEM_TYPE_DEFINITIONS)) {
  ItemTypeRegistry.register(def)
}
