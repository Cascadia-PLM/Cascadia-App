// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ConfigService: the change-type mapping is read and written under one key.
 *
 * Data-integrity gate. Change-order creation starts the Driving definition
 * `lifecyclesByChangeType` names, and the mapping shipped under
 * `workflowsByChangeType`. For one release a row an older build wrote, or a
 * request from an older client, may still say the old name; if the service
 * failed to fold it in, every change order on that install would refuse to
 * be created with "no workflow configured" (remediation plan CM-25).
 *
 * Run: npx vitest run cascadia-api/src/lib/config/ConfigService.test.ts
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
import { ConfigService, normalizeRuntimeConfig } from './ConfigService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { overrideItemTypeConfig } from '@/__tests__/fixtures/lifecycles'
import { itemTypeConfigs } from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { ValidationError } from '@/lib/errors'
import { takeFirst } from '@/lib/db/take-first'
import '@/lib/items/registerItemTypes.server'

const DEFINITION = '00000000-0000-4000-8000-000000000102'
const OTHER = '00000000-0000-4000-8000-000000000103'
/** The Part lifecycle: Driven, ECO-controlled. */
const PART_LIFECYCLE = '00000000-0000-4000-8000-000000000100'

describe('normalizeRuntimeConfig', () => {
  it('folds the legacy key into lifecyclesByChangeType', () => {
    expect(
      normalizeRuntimeConfig({
        lifecycleDefinitionId: DEFINITION,
        workflowsByChangeType: { ECO: DEFINITION },
      }),
    ).toEqual({
      lifecycleDefinitionId: DEFINITION,
      lifecyclesByChangeType: { ECO: DEFINITION },
    })
  })

  it('lets the new key win when both are present, and drops the old one', () => {
    expect(
      normalizeRuntimeConfig({
        lifecyclesByChangeType: { ECO: DEFINITION },
        workflowsByChangeType: { ECO: OTHER },
      }),
    ).toEqual({ lifecyclesByChangeType: { ECO: DEFINITION } })
  })

  it('leaves a config without the legacy key alone', () => {
    const config = { lifecyclesByChangeType: { ECO: DEFINITION } }
    expect(normalizeRuntimeConfig(config)).toBe(config)
  })
})

describe('ConfigService change-type mapping', () => {
  const testDb = new TestDatabase()
  let userId: string
  let restore: (() => Promise<void>) | null = null

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    const user = await insertTestUser(testDb.db)
    userId = user.id
  })

  afterEach(async () => {
    if (restore) await restore()
    restore = null
    await testDb.rollback()
    await ItemTypeRegistry.reload()
  })

  it('reads a row stored under the legacy key as lifecyclesByChangeType', async () => {
    // A row from before migration 0005, or written by an older build —
    // through the fixture, which captures the shared row and hands back the
    // undo that afterEach runs before the rollback.
    restore = await overrideItemTypeConfig(
      testDb.db,
      'ChangeOrder',
      {
        lifecycleDefinitionId: DEFINITION,
        workflowsByChangeType: { ECO: DEFINITION },
      },
      userId,
    )

    const one = await ConfigService.getConfig('ChangeOrder')
    expect(one?.config.lifecyclesByChangeType).toEqual({ ECO: DEFINITION })
    expect(one?.config.workflowsByChangeType).toBeUndefined()

    const all = await ConfigService.getAllConfigs()
    const row = all.find((c) => c.itemType === 'ChangeOrder')
    expect(row?.config.lifecyclesByChangeType).toEqual({ ECO: DEFINITION })
    expect(row?.config.workflowsByChangeType).toBeUndefined()
  })

  /**
   * Security gate. `isBranchProtectionExempt` exempts Free and Driving
   * lifecycles, so a Part pointed at a change-order workflow stops being
   * ECO-controlled and can be written straight to a protected main. The check
   * that refuses it lived in a wrapper method no route called, which is why
   * this asserts through `saveConfig` — the path the admin API actually takes.
   */
  it('refuses to point an item type at a change-order workflow', async () => {
    await expect(
      ConfigService.saveConfig(
        'Part',
        { lifecycleDefinitionId: DEFINITION },
        userId,
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses to point a workflow-governed type at an item lifecycle', async () => {
    await expect(
      ConfigService.saveConfig(
        'ChangeOrder',
        { lifecycleDefinitionId: PART_LIFECYCLE },
        userId,
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('accepts the change-order workflow for the type it governs', async () => {
    // The shipped ChangeOrder configuration. A blanket "no Driving targets"
    // gate would reject this, which is why the check compares kinds.
    const saved = await ConfigService.saveConfig(
      'ChangeOrder',
      {
        lifecycleDefinitionId: DEFINITION,
        lifecyclesByChangeType: { ECO: DEFINITION },
      },
      userId,
    )

    expect(saved.config.lifecycleDefinitionId).toBe(DEFINITION)
  })

  it('stores a config sent under the legacy key under the new one only', async () => {
    await ConfigService.saveConfig(
      'ChangeOrder',
      {
        lifecycleDefinitionId: DEFINITION,
        workflowsByChangeType: { ECO: DEFINITION, XCO: OTHER },
      },
      userId,
    )

    const stored = takeFirst(
      await testDb.db
        .select({ config: itemTypeConfigs.config })
        .from(itemTypeConfigs)
        .where(eq(itemTypeConfigs.itemType, 'ChangeOrder')),
    )
    expect(stored.config.lifecyclesByChangeType).toEqual({
      ECO: DEFINITION,
      XCO: OTHER,
    })
    expect('workflowsByChangeType' in stored.config).toBe(false)
  })
})
