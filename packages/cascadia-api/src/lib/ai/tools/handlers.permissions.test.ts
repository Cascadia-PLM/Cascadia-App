// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI/MCP read tools — program isolation on the by-id path
 *
 * Security gate. `get_item_details` scoped its *by-number* lookup to the
 * caller's accessible designs, but its by-id branch — and `get_bom`,
 * `get_where_used` and `analyze_change_impact`, which take an item id and
 * nothing else — went straight to `ItemService.findById`. The RBAC check the
 * wrapper applies is instance-blind, so a chatbot user or an MCP agent holding
 * `parts:read` could read any program's item, its BOM, and its where-used tree
 * by knowing a UUID.
 *
 * Both users hold the same role and differ only in program membership, so a
 * refusal can only come from the design gate. The MCP leg drives the same
 * handler through `toolRegistry[].invoke` with a `keyScope`, proving the gate
 * sits below both surfaces rather than in either one's plumbing.
 *
 * Run: npx vitest run packages/core/src/lib/ai/tools/handlers.permissions.test.ts
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
import {
  analyzeChangeImpactHandler,
  getBomHandler,
  getItemDetailsHandler,
  getWhereUsedHandler,
} from './handlers'
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
import { PermissionDeniedError } from '@/lib/errors'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

describe('AI read tools — program isolation on the by-id path', () => {
  const testDb = new TestDatabase()

  let member: TestUser
  let outsider: TestUser
  let auditor: TestUser
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

    // Identical `parts` RBAC for member and outsider, and pointedly no
    // programs:manage — that is the cross-program bypass, which the auditor
    // holds instead.
    const engineerRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`AI Tools Engineer ${randomUUID().slice(0, 8)}`, {
        parts: ['create', 'read', 'update'],
        designs: ['create', 'read'],
      }),
    )
    const auditorRole = await insertTestRole(
      testDb.db,
      createCustomTestRole(`AI Tools Auditor ${randomUUID().slice(0, 8)}`, {
        parts: ['read'],
        programs: ['manage'],
      }),
    )

    member = await insertTestUser(testDb.db)
    outsider = await insertTestUser(testDb.db)
    auditor = await insertTestUser(testDb.db)
    await assignRoleToUser(testDb.db, member.id, engineerRole.id)
    await assignRoleToUser(testDb.db, outsider.id, engineerRole.id)
    await assignRoleToUser(testDb.db, auditor.id, auditorRole.id)
    permissionService.clearCache()

    const program = await ProgramService.create(
      {
        name: 'AI Tools Program',
        code: `AIT-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'AI Tools Design',
        code: `AITD-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )
    // The outsider is a normal user with a program of their own, not a user
    // with nothing to reach.
    await ProgramService.create(
      {
        name: 'AI Tools Outsider Program',
        code: `AITO-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      outsider.id,
    )

    const part = await ItemService.create<Part>(
      'Part',
      {
        itemType: 'Part',
        designId: design.id,
        revision: 'A',
        name: 'Confidential Assembly',
        partType: 'Manufacture',
      },
      member.id,
    )
    partId = part.id!
    partNumber = part.itemNumber!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  const ctx = (
    user: TestUser,
    extra: Partial<ToolContext> = {},
  ): ToolContext => ({ userId: user.id, ...extra })

  /** Each by-id tool, invoked against the member's part. */
  function byIdCalls(user: TestUser, extra: Partial<ToolContext> = {}) {
    const context = ctx(user, extra)
    return [
      [
        'get_item_details',
        () => getItemDetailsHandler({ id: partId }, context),
      ],
      ['get_bom', () => getBomHandler({ itemId: partId }, context)],
      [
        'get_where_used',
        () => getWhereUsedHandler({ itemId: partId }, context),
      ],
      [
        'analyze_change_impact',
        () => analyzeChangeImpactHandler({ itemId: partId }, context),
      ],
    ] as const
  }

  it('refuses a non-member every by-id read tool', async () => {
    for (const [label, call] of byIdCalls(outsider)) {
      await expect(call(), label).rejects.toBeInstanceOf(PermissionDeniedError)
    }
  })

  it('serves the member every by-id read tool', async () => {
    for (const [label, call] of byIdCalls(member)) {
      await expect(call(), label).resolves.toBeDefined()
    }
  })

  it('serves cross-program authority every by-id read tool', async () => {
    for (const [label, call] of byIdCalls(auditor)) {
      await expect(call(), label).resolves.toBeDefined()
    }
  })

  it('refuses over MCP too, with a scoped key', async () => {
    // The registry documents the handlers as the enforcement point. Driving
    // `invoke` with a full `parts` keyScope shows the gate is not something
    // the chat surface adds on top.
    const context = ctx(outsider, { keyScope: { parts: ['read'] } })

    for (const name of [
      'get_item_details',
      'get_bom',
      'get_where_used',
      'analyze_change_impact',
    ]) {
      const entry = toolRegistry.find((e) => e.name === name)
      expect(entry, name).toBeDefined()

      const input =
        name === 'get_item_details' ? { id: partId } : { itemId: partId }
      await expect(entry!.invoke(input, context), name).rejects.toBeInstanceOf(
        PermissionDeniedError,
      )
    }
  })

  it('leaves the by-number path scoped exactly as it was', async () => {
    // Regression guard on the branch that was already correct: a non-member
    // looking the same part up by number still finds nothing, and the member
    // still finds it.
    await expect(
      getItemDetailsHandler({ itemNumber: partNumber }, ctx(outsider)),
    ).rejects.toThrow(/not found/i)

    await expect(
      getItemDetailsHandler({ itemNumber: partNumber }, ctx(member)),
    ).resolves.toBeDefined()
  })

  it('answers a nonexistent id as not-found, not as a refusal', async () => {
    // 404-vs-403 still distinguishes a real foreign id from a fabricated one,
    // matching the REST by-id convention. Pinned so the trade-off is explicit.
    await expect(
      getBomHandler({ itemId: randomUUID() }, ctx(outsider)),
    ).rejects.toThrow(/not found/i)
  })
})
