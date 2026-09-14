// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Which program a change order's facts name.
 *
 * Gate 2. A program-scoped webhook subscription receives a change order's
 * facts only when they name its program, and the failure to avoid is the
 * leak: a change order spanning two programs naming one of them, so the other
 * program's changes reach a subscriber scoped to the first. Null is the safe
 * answer, and these pin when it is the answer.
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
import { resolveChangeOrderProgram } from './program-scope'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { db } from '@/lib/db'
import { changeOrderDesigns, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { DesignService } from '@/lib/services/DesignService'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('resolveChangeOrderProgram', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let unique: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    unique = `PS${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function programWithDesigns(label: string, count: number) {
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: `Scope ${label}`,
          code: `PS-${unique}-${label.toUpperCase()}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const designIds: Array<string> = []
    for (let index = 0; index < count; index++) {
      const design = await DesignService.create(
        {
          programId: program.id,
          name: `Scope design ${label} ${index}`,
          code: `SD-${unique}-${label.toUpperCase()}-${index}`,
          designType: 'Engineering',
        },
        user.id,
      )
      designIds.push(design.id)
    }
    return { programId: program.id, designIds }
  }

  async function changeOrderLinking(designIds: Array<string>) {
    const changeOrder = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: `Scope ECO ${unique}`,
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Scope',
      } as any,
      user.id,
    )
    for (const designId of designIds) {
      await testDb.db
        .insert(changeOrderDesigns)
        .values({ changeOrderId: changeOrder.id, designId })
    }
    return changeOrder.id
  }

  const resolve = (changeOrderId: string) =>
    db.transaction((tx) => resolveChangeOrderProgram(tx, changeOrderId))

  it('names the program every linked design belongs to', async () => {
    const { programId, designIds } = await programWithDesigns('one', 2)
    const changeOrderId = await changeOrderLinking(designIds)

    expect(await resolve(changeOrderId)).toBe(programId)
  })

  it('names none for a change order whose designs span programs', async () => {
    const first = await programWithDesigns('first', 1)
    const second = await programWithDesigns('second', 1)
    const changeOrderId = await changeOrderLinking([
      ...first.designIds,
      ...second.designIds,
    ])

    expect(await resolve(changeOrderId)).toBeNull()
  })

  it('names none for a change order that links no design yet', async () => {
    const changeOrderId = await changeOrderLinking([])

    expect(await resolve(changeOrderId)).toBeNull()
  })
})
