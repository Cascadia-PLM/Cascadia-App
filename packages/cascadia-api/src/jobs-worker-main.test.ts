// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The jobs worker's composition root — wiring test
 *
 * Item type registration is a side effect of importing
 * `registerItemTypes.server`, and on the HTTP side every route module imports
 * it. This process mounts no routes. So the registry was empty here, and
 * `LifecycleService` answered "no lifecycle assigned" for every type — which
 * `design.clone` hit on its first item and reported to the operator as an
 * unseeded database.
 *
 * What this pins is the worker's *module graph*, which is why it imports the
 * entry point rather than a handler: `design-clone.test.ts` registers the item
 * types itself, and a handler test that arranges its own registration is
 * exactly what let the gap ship green.
 *
 * Run: npx vitest run packages/cascadia-api/src/jobs-worker-main.test.ts
 */

import { describe, expect, it } from 'vitest'
import { ITEM_TYPE_DEFINITIONS } from '@cascadia/commons/lib/items/item-type-definitions'
import { ItemTypeRegistry } from '@/lib/items/registry'
// The subject under test: importing it must be enough.
import '@/jobs-worker-main'

describe('jobs worker composition root', () => {
  it('registers every item type by importing the worker entry', () => {
    for (const name of Object.keys(ITEM_TYPE_DEFINITIONS)) {
      expect(
        ItemTypeRegistry.getCodeDefinition(name),
        `Item type "${name}" is not registered in the jobs worker process. ` +
          'The worker mounts no routes, so it must import ' +
          'lib/items/registerItemTypes.server itself.',
      ).toBeDefined()
    }
  })

  it('resolves a lifecycle for every item type, as design.clone does', async () => {
    await ItemTypeRegistry.initialize()

    for (const name of Object.keys(ITEM_TYPE_DEFINITIONS)) {
      expect(
        await ItemTypeRegistry.getAssignedDefinitionForType(name),
        `Item type "${name}" resolves no lifecycle definition in the worker ` +
          'process; every job that reads an initial state would fail on it.',
      ).toBeDefined()
    }
  })
})
