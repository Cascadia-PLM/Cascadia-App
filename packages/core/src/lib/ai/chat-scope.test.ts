// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI chat scope resolution — program isolation
 *
 * Security gate. `POST /api/ai/chat` took `programId` from the request body and
 * handed it to `isAIEnabled`, to `loadProviderConfig` (where the provider API
 * key and the monthly token budget live) and to `createSession`, which stored
 * it. Nothing checked membership, so a non-member could name any program and
 * spend its key, exhaust its budget, read its name back out of the system
 * prompt, and have the `ai_usage_logs` row attributed to it.
 *
 * The rule lives in `resolveChatScope` so it can be asserted directly rather
 * than through an LLM stream. The invariant every case here protects: the
 * program a request spends against is one the caller can reach, and for an
 * existing session it is that session's own.
 *
 * Run: npx vitest run packages/core/src/lib/ai/chat-scope.test.ts
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
import { resolveChatScope } from './chat-scope'
import { sessionService } from './SessionService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { DesignService } from '@/lib/services/DesignService'
import { ProgramService } from '@/lib/services/ProgramService'
import { permissionService } from '@/lib/auth/permission-service'
import { PermissionDeniedError } from '@/lib/errors'

describe('resolveChatScope — AI chat program isolation', () => {
  const testDb = new TestDatabase()

  let member: TestUser
  let outsider: TestUser
  let programId: string
  let designId: string
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
      createCustomTestRole(`Chat Scope ${randomUUID().slice(0, 8)}`, {
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

    const program = await ProgramService.create(
      {
        name: 'Chat Program',
        code: `CHT-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    programId = program.id
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Chat Design',
        code: `CHTD-${Date.now()}`,
        designType: 'Engineering',
      },
      member.id,
    )
    designId = design.id

    const outsiderProgram = await ProgramService.create(
      {
        name: 'Chat Outsider Program',
        code: `CHTO-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      outsider.id,
    )
    outsiderProgramId = outsiderProgram.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('refuses a non-member naming another program', async () => {
    await expect(
      resolveChatScope(outsider.id, { programId }, sessionService),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('refuses a non-member naming another program’s design', async () => {
    await expect(
      resolveChatScope(
        outsider.id,
        { programId: outsiderProgramId, designId },
        sessionService,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('admits a member naming their own program and design', async () => {
    await expect(
      resolveChatScope(member.id, { programId, designId }, sessionService),
    ).resolves.toEqual({ sessionId: null, programId, designId })
  })

  it('lets an existing session’s program win over the body’s', async () => {
    // The attack this closes: keep your own session id, swap in someone
    // else's programId, and spend their key. The session's scope is what
    // every downstream decision uses.
    const session = await sessionService.createSession(
      outsider.id,
      outsiderProgramId,
    )

    const scope = await resolveChatScope(
      outsider.id,
      { sessionId: session.id, programId },
      sessionService,
    )

    expect(scope.programId).toBe(outsiderProgramId)
    expect(scope.sessionId).toBe(session.id)
  })

  it('refuses a session that is not the caller’s', async () => {
    const session = await sessionService.createSession(member.id, programId)

    await expect(
      resolveChatScope(outsider.id, { sessionId: session.id }, sessionService),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('allows a program-less session, resolving to the global config', async () => {
    // Deliberate, per the maintainer's ruling: a user with no program can
    // still ask the assistant a question, and it spends the instance admin's
    // own global provider configuration and budget rather than any program's.
    await expect(
      resolveChatScope(outsider.id, {}, sessionService),
    ).resolves.toEqual({ sessionId: null, programId: null, designId: null })
  })

  it('refuses a session id that names nothing, rather than trusting the body', async () => {
    // A deleted session must not degrade into "create a fresh one under
    // whatever programId the body claimed". Ownership fails first, so this
    // is a refusal; the code's own fall-through path (owner verified, row
    // gone) re-checks the body scope for the same reason.
    const ownedButGone = await sessionService.createSession(
      outsider.id,
      outsiderProgramId,
    )
    await sessionService.deleteSession(ownedButGone.id)

    await expect(
      resolveChatScope(
        outsider.id,
        { sessionId: ownedButGone.id, programId },
        sessionService,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })
})
