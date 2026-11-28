// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI chat page context — program isolation
 *
 * Security gate. The chat panel sends the ids of the page it is open on, and
 * the server turns them into names in the system prompt and into the scope a
 * new session spends against. Those ids arrive in a request body, so they are
 * claims: a caller who names another program's item, design or program must
 * get nothing back for it — not its name in the prompt, and not its program
 * as the session's scope.
 *
 * The invariant every case protects: everything `resolveChatPage` returns is
 * something the caller can reach, and the program it returns is the one the
 * item or design actually belongs to, whatever the body said.
 *
 * Run: npx vitest run cascadia-api/src/ai/page-context.test.ts
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
import { chatPageSchema, resolveChatPage } from './page-context'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestPart } from '@/__tests__/fixtures/items'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { permissionService } from '@/auth/permission-service'

describe('resolveChatPage — AI chat page context isolation', () => {
  const testDb = new TestDatabase()

  let member: TestUser
  let outsider: TestUser
  let programId: string
  let designId: string
  let itemId: string
  let outsiderProgramId: string

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
      createCustomTestRole(`Chat Page ${randomUUID().slice(0, 8)}`, {
        parts: ['read'],
        designs: ['create', 'read'],
        programs: ['read'],
      }),
    )
    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    for (const u of [member, outsider]) {
      await assignRoleToUser(testDb.db, u.id, role.id)
    }
    permissionService.clearCache()

    const suffix = `${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`
    const program = await ProgramService.create(
      { name: 'Page Program', code: `PG-${suffix}` },
      member.id,
    )
    programId = program.id
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Page Design',
        code: `PGD-${suffix}`,
        designType: 'Engineering',
      },
      member.id,
    )
    designId = design.id
    const { item } = await insertTestPart(testDb.db, designId, member.id)
    itemId = item.id

    const outsiderProgram = await ProgramService.create(
      { name: 'Page Outsider Program', code: `PGO-${suffix}` },
      outsider.id,
    )
    outsiderProgramId = outsiderProgram.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('resolves a member’s item to its own design and program', async () => {
    const page = await resolveChatPage(member.id, { itemId })

    expect(page?.item?.id).toBe(itemId)
    expect(page?.design?.id).toBe(designId)
    expect(page?.program?.id).toBe(programId)
  })

  it('gives a non-member nothing for another program’s item', async () => {
    expect(await resolveChatPage(outsider.id, { itemId })).toBeNull()
  })

  it('gives a non-member nothing for another program’s design or program', async () => {
    expect(await resolveChatPage(outsider.id, { designId })).toBeNull()
    expect(await resolveChatPage(outsider.id, { programId })).toBeNull()
  })

  it('takes the program from the design, not from the body', async () => {
    // The pairing an attacker would send: a design they can reach, with the
    // program they want to spend against alongside it.
    const page = await resolveChatPage(member.id, {
      designId,
      programId: outsiderProgramId,
    })

    expect(page?.program?.id).toBe(programId)
  })

  it('does not fall back to the body’s scope when the item is out of reach', async () => {
    // An unreachable item must not degrade into "use the designId and
    // programId that came with it" for anything the caller cannot reach.
    const page = await resolveChatPage(outsider.id, {
      itemId,
      designId,
      programId,
    })

    expect(page).toBeNull()
  })

  it('treats an unknown id like an unreachable one', async () => {
    expect(
      await resolveChatPage(member.id, { itemId: randomUUID() }),
    ).toBeNull()
  })

  it('drops a malformed page instead of rejecting the request body', () => {
    expect(chatPageSchema.parse({ itemId: 'new' })).toEqual({})
    expect(chatPageSchema.parse('nonsense')).toBeUndefined()
  })
})
