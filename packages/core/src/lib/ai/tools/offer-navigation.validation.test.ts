// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `offer_navigation` input shaping.
 *
 * Security gate. The tool's whole output is a URL the chat panel turns into a
 * one-click button, and both halves of that URL come from the model — which
 * chose them after reading tool results, i.e. item names and descriptions any
 * user with write access can author. `itemId` was interpolated raw and for
 * Program, Design and ChangeOrder never reached a service that would have
 * rejected it; `tab` was appended raw after a `?`, so a value carrying its own
 * `?`, `#` or `/` rewrote the destination rather than selecting a tab.
 *
 * The invariant: what this tool hands back is a route in this app addressed by
 * a UUID, whatever the model asked for. The hostile cases go through
 * `toolRegistry[].invoke`, whose input is `unknown` — the registry documents
 * pre-validation as a caller convention, and the point of these cases is that
 * the handler does not depend on the convention being honoured.
 *
 * Run: npx vitest run packages/core/src/lib/ai/tools/offer-navigation.validation.test.ts
 */

import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { offerNavigationHandler } from './handlers'
import { toolRegistry } from './registry'
import type { ToolContext } from './permission-wrapper'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { permissionService } from '@/lib/auth/permission-service'
import { ValidationError } from '@/lib/errors'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('offer_navigation — navigation URL inputs', () => {
  const testDb = new TestDatabase()

  let user: TestUser
  let context: ToolContext
  let partId: string
  let partNumber: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    const role = await insertTestRole(
      testDb.db,
      createCustomTestRole(`AI Navigator ${randomUUID().slice(0, 8)}`, {
        parts: ['create', 'read', 'update'],
        designs: ['create', 'read'],
      }),
    )
    user = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, user.id, role.id)
    permissionService.clearCache()
    context = { userId: user.id }

    const program = await ProgramService.create(
      {
        name: 'Navigation Program',
        code: `NAV-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      user.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Navigation Design',
        code: `NAVD-${Date.now()}`,
        designType: 'Engineering',
      },
      user.id,
    )
    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Navigable Assembly',
        partType: 'Manufacture',
      },
      user.id,
    )
    partId = part.id!
    partNumber = part.itemNumber!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /** Drive the handler with input nothing has validated, as a surface would. */
  function invokeUnchecked(input: unknown): Promise<unknown> {
    const entry = toolRegistry.find((e) => e.name === 'offer_navigation')
    expect(entry).toBeDefined()
    return entry!.invoke(input, context)
  }

  it('still builds the URLs it built before', async () => {
    await expect(
      offerNavigationHandler(
        { itemId: partId, itemNumber: partNumber, itemType: 'Part' },
        context,
      ),
    ).resolves.toEqual({ navigationUrl: `/parts/${partId}`, displayed: true })

    await expect(
      offerNavigationHandler(
        {
          itemId: partId,
          itemNumber: partNumber,
          itemType: 'Part',
          tab: 'bom',
        },
        context,
      ),
    ).resolves.toEqual({
      navigationUrl: `/parts/${partId}?tab=bom`,
      displayed: true,
    })

    // The types that reach no service keep working on a well-formed id.
    const programId = randomUUID()
    await expect(
      offerNavigationHandler(
        { itemId: programId, itemNumber: 'NAV', itemType: 'Program' },
        context,
      ),
    ).resolves.toEqual({
      navigationUrl: `/programs/${programId}`,
      displayed: true,
    })
  })

  it('rejects an itemId that is not a UUID', async () => {
    for (const itemId of [
      'not-a-uuid',
      '../../admin',
      `${randomUUID()}/../../admin`,
      'https://exfil.example/collect',
      '',
    ]) {
      await expect(
        invokeUnchecked({
          itemId,
          itemNumber: 'P-1001',
          itemType: 'Program',
        }),
        itemId || '(empty)',
      ).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('rejects a bad itemId on the types that do reach a service too', async () => {
    // Part goes through ItemService.findById, so this one used to fail as a
    // lookup rather than as a shape check. It must fail before the lookup:
    // that is what makes the rule the same for every item type.
    await expect(
      invokeUnchecked({
        itemId: `${partId}?x=`,
        itemNumber: partNumber,
        itemType: 'Part',
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a tab that would rewrite the destination', async () => {
    for (const tab of [
      'x?redirect=https://exfil.example',
      'bom#/programs',
      '../tasks',
      'bom&next=/admin',
      'a'.repeat(41),
    ]) {
      await expect(
        invokeUnchecked({
          itemId: partId,
          itemNumber: partNumber,
          itemType: 'Part',
          tab,
        }),
        tab,
      ).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('leaves a missing item answering not-found, not invalid', async () => {
    // A well-formed id for an item that is not there is a different failure
    // from a malformed one, and stays one.
    await expect(
      offerNavigationHandler(
        { itemId: randomUUID(), itemNumber: 'P-9999', itemType: 'Part' },
        context,
      ),
    ).rejects.toThrow(/not found/i)
  })
})
