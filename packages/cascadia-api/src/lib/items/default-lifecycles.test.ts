// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Seeding the shipped defaults is configuration data integrity: every item
 * type must resolve a lifecycle, and a re-seed must only ever move a row
 * forward. The bug this guards against was real — the app seed once wrote
 * its own copy of a lifecycle unconditionally, handing back an older shape
 * while the version number stayed newer, so the gate then refused to repair
 * it.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { eq } from 'drizzle-orm'
import {
  DEFAULT_ITEM_LIFECYCLES,
  DEFAULT_LIFECYCLE_LINKS,
  seedDefaultLifecycles,
} from './default-lifecycles'
import { LIFECYCLE_IDS } from './lifecycle-ids'
import { TestDatabase } from '@/__tests__/helpers/db'
import { itemTypeConfigs, lifecycleDefinitions } from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import '@/lib/items/registerItemTypes.server'

interface StoredDefinition {
  states: Array<{
    id: string
    isInitial?: boolean
    position?: { x: number; y: number }
  }>
}

describe('seedDefaultLifecycles', () => {
  const testDb = new TestDatabase()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function readTool() {
    const [row] = await testDb.db
      .select({
        version: lifecycleDefinitions.version,
        definition: lifecycleDefinitions.definition,
        drivers: lifecycleDefinitions.drivers,
      })
      .from(lifecycleDefinitions)
      .where(eq(lifecycleDefinitions.id, LIFECYCLE_IDS.tool))
    if (!row) throw new Error('Tool lifecycle missing')
    return { ...row, definition: row.definition as StoredDefinition }
  }

  const shippedTool = DEFAULT_ITEM_LIFECYCLES.find(
    (l) => l.id === LIFECYCLE_IDS.tool,
  )
  if (!shippedTool) throw new Error('no shipped Tool lifecycle')
  const shippedToolStates = (
    shippedTool.definition as unknown as StoredDefinition
  ).states

  it('links every registered item type to a shipped definition', () => {
    const shipped = new Set(DEFAULT_ITEM_LIFECYCLES.map((l) => l.id))
    for (const link of DEFAULT_LIFECYCLE_LINKS) {
      expect(shipped.has(link.lifecycleDefinitionId)).toBe(true)
    }
    const linked = new Set(DEFAULT_LIFECYCLE_LINKS.map((l) => l.itemType))
    for (const config of ItemTypeRegistry.getAllTypes()) {
      expect(linked.has(config.name)).toBe(true)
    }
  })

  it('ships every state with an editor position', () => {
    for (const lifecycle of DEFAULT_ITEM_LIFECYCLES) {
      for (const state of (lifecycle.definition as unknown as StoredDefinition)
        .states) {
        expect(state.position).toBeDefined()
      }
    }
  })

  /**
   * `StateNode` connects bottom-to-top, so a shipped default only reads as a
   * flow if its ranks run downward — the initial state at the top. Ranking
   * left-to-right instead still produces non-overlapping boxes and still
   * passes every other gate here, so nothing but this catches it; what it
   * looked like was every edge leaving downward and looping back up, which is
   * how the ECO lifecycle tab shipped until the layout moved to `rankdir: TB`.
   */
  it('lays every default out downward from its initial state', () => {
    for (const lifecycle of DEFAULT_ITEM_LIFECYCLES) {
      const states = (lifecycle.definition as unknown as StoredDefinition)
        .states
      const top = Math.min(...states.map((s) => s.position!.y))
      for (const state of states.filter((s) => s.isInitial)) {
        expect(`${lifecycle.name}/${state.id} y=${state.position!.y}`).toBe(
          `${lifecycle.name}/${state.id} y=${top}`,
        )
      }
    }
  })

  it('upgrades a row that is behind the shipped version', async () => {
    await testDb.db
      .update(lifecycleDefinitions)
      .set({
        version: 0,
        definition: {
          states: [{ id: 'Stale', name: 'Stale', isInitial: true }],
          transitions: [],
          lifecycleType: 'Free',
        },
      })
      .where(eq(lifecycleDefinitions.id, LIFECYCLE_IDS.tool))

    await seedDefaultLifecycles(testDb.db)

    const row = await readTool()
    expect(row.version).toBe(shippedTool.version)
    expect(row.definition.states.map((s) => s.id)).toEqual(
      shippedToolStates.map((s) => s.id),
    )
  })

  it('never downgrades a row at or past the shipped version', async () => {
    const edited = {
      states: [
        { id: 'Edited', name: 'Edited', isInitial: true, isFinal: true },
      ],
      transitions: [],
      lifecycleType: 'Free',
    }
    await testDb.db
      .update(lifecycleDefinitions)
      .set({ version: shippedTool.version + 1, definition: edited })
      .where(eq(lifecycleDefinitions.id, LIFECYCLE_IDS.tool))

    await seedDefaultLifecycles(testDb.db)
    await seedDefaultLifecycles(testDb.db)

    const row = await readTool()
    expect(row.version).toBe(shippedTool.version + 1)
    expect(row.definition.states.map((s) => s.id)).toEqual(['Edited'])
  })

  it('leaves a configured drivers allow-list and a richer type config alone', async () => {
    await testDb.db
      .update(lifecycleDefinitions)
      .set({ drivers: [LIFECYCLE_IDS.changeOrder] })
      .where(eq(lifecycleDefinitions.id, LIFECYCLE_IDS.tool))
    const richer = {
      lifecycleDefinitionId: LIFECYCLE_IDS.tool,
      permissions: {
        create: ['Administrator'],
        read: ['*'],
        update: ['Administrator'],
        delete: ['Administrator'],
      },
    }
    await testDb.db
      .update(itemTypeConfigs)
      .set({ config: richer })
      .where(eq(itemTypeConfigs.itemType, 'Tool'))

    await seedDefaultLifecycles(testDb.db)

    expect((await readTool()).drivers).toEqual([LIFECYCLE_IDS.changeOrder])
    const [config] = await testDb.db
      .select({ config: itemTypeConfigs.config })
      .from(itemTypeConfigs)
      .where(eq(itemTypeConfigs.itemType, 'Tool'))
    expect(config?.config).toEqual(richer)
  })
})
