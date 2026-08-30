// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * findRelatedChanges — with and without a current change order
 *
 * The exclusion of the asking ECO is a uuid comparison, so "no current ECO"
 * cannot be spelled as `''`: Postgres rejects the whole statement rather than
 * matching nothing, and the caller sees a cast error instead of a result. That
 * is what `analyze_change_impact` did on every item it was asked about, over
 * both the chatbot and MCP.
 *
 * Nothing about that is visible to tsc — an empty string is a `string` — so
 * these run the real query against real Postgres.
 *
 * Run: npx vitest run src/lib/items/services/ImpactAssessmentService.related-changes.test.ts
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
import { ImpactAssessmentService } from './ImpactAssessmentService'
import { ItemService } from './ItemService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { DesignService } from '@/lib/services/DesignService'
import {
  changeOrderAffectedItems,
  programs,
  workflowInstances,
} from '@/lib/db/schema'

import '@/lib/items/registerItemTypes.server'

describe('ImpactAssessmentService.findRelatedChanges', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  // The user/program/design fixtures are created INSIDE the gate transaction so
  // they roll back with it. Anything written from beforeAll autocommits on the
  // pool and leaks permanently — nothing truncates the test database.
  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `REL${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    user = await insertTestUser(testDb.db)

    const [program] = await testDb.db
      .insert(programs)
      .values({
        code: `PGM-${uniquePrefix}`,
        name: 'Related Changes Program',
        createdBy: user.id,
      })
      .returning()

    const design = await DesignService.create(
      {
        code: `DSN-${uniquePrefix}`,
        name: 'Related Changes Design',
        programId: program!.id,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function createPart(suffix: string) {
    return ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Part ${suffix}`,
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
  }

  /** An open ECO (workflow instance still running) affecting `partId`. */
  async function createOpenEcoAffecting(name: string, partId: string) {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name,
        changeType: 'ECO',
        priority: 'medium',
      } as any,
      user.id,
    )
    await testDb.db.insert(workflowInstances).values({
      itemId: eco.id,
      currentState: 'Draft',
    })
    await testDb.db.insert(changeOrderAffectedItems).values({
      changeOrderId: eco.id,
      affectedItemId: partId,
      changeAction: 'revise',
      createdBy: user.id,
    })
    return eco
  }

  it('returns every open change order when there is no current one', async () => {
    const part = await createPart('shared')
    const first = await createOpenEcoAffecting('First ECO', part.id)
    const second = await createOpenEcoAffecting('Second ECO', part.id)

    const related = await ImpactAssessmentService.findRelatedChanges(
      undefined,
      [part.id],
    )

    expect(related.map((c) => c.changeOrderId).sort()).toEqual(
      [first.id, second.id].sort(),
    )
  })

  it('excludes the change order that is asking', async () => {
    const part = await createPart('asker')
    const asking = await createOpenEcoAffecting('Asking ECO', part.id)
    const other = await createOpenEcoAffecting('Other ECO', part.id)

    const related = await ImpactAssessmentService.findRelatedChanges(
      asking.id,
      [part.id],
    )

    expect(related.map((c) => c.changeOrderId)).toEqual([other.id])
  })
})
