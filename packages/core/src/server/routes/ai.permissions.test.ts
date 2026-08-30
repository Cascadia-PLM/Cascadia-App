// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AI routes — program isolation at the HTTP edge
 *
 * Security gate, covering the two route-level halves of the chat-scope fix
 * that `chat-scope.test.ts` cannot reach from the helper alone:
 *
 *   - `GET /api/ai/settings?programId=…` returned any program's AI settings
 *     row — provider, model, enabled flag, and the fact that a key is held —
 *     to any authenticated user.
 *   - `POST /api/ai/sessions` stored a client-supplied `programId` with no
 *     membership check, which is what later `POST /chat` requests spend
 *     against.
 *
 * Run: npx vitest run packages/core/src/server/routes/ai.permissions.test.ts
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
import { Hono } from 'hono'
import aiRoutes from './ai'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { ProgramService } from '@/lib/services/ProgramService'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import { aiSettings } from '@/lib/db/schema/ai'
import { ErrorCode } from '@/lib/errors/codes'

interface ErrorEnvelope {
  error: { code: string }
}

describe('AI routes — program isolation', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/ai', aiRoutes)

  let member: TestUser
  let outsider: TestUser
  let programId: string

  const cookies = new Map<string, string>()

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
      createCustomTestRole(`AI Routes ${randomUUID().slice(0, 8)}`, {
        parts: ['read'],
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
        name: 'AI Routes Program',
        code: `AIR-${Date.now()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      },
      member.id,
    )
    programId = program.id

    await testDb.db.insert(aiSettings).values({
      programId,
      provider: 'anthropic',
      config: {
        provider: 'anthropic',
        apiKey: 'sk-secret',
        model: 'claude-opus-5',
      },
      enabled: true,
    })

    cookies.clear()
    for (const u of [member, outsider]) {
      const { sessionToken } = await SessionManager.createSession(u.id)
      cookies.set(u.id, `session=${sessionToken}`)
    }
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  function request(user: TestUser, path: string, body?: object) {
    return app.request(path, {
      method: body ? 'POST' : 'GET',
      headers: {
        Cookie: cookies.get(user.id)!,
        Origin: 'http://localhost',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }

  it('refuses a non-member another program’s AI settings', async () => {
    const response = await request(
      outsider,
      `/api/ai/settings?programId=${programId}`,
    )

    expect(response.status).toBe(403)
    const payload = (await response.json()) as ErrorEnvelope
    expect(payload.error.code).toBe(ErrorCode.PERMISSION_DENIED)
  })

  it('serves a member their own program’s AI settings', async () => {
    const response = await request(
      member,
      `/api/ai/settings?programId=${programId}`,
    )

    expect(response.status).toBe(200)
  })

  it('leaves the global settings read open to any authenticated user', async () => {
    // Deliberate: with no programId there is no program to be a member of.
    // Writes are still system:manage.
    expect((await request(outsider, '/api/ai/settings')).status).toBe(200)
  })

  it('refuses a non-member creating a session scoped to that program', async () => {
    const response = await request(outsider, '/api/ai/sessions', { programId })

    expect(response.status).toBe(403)
  })

  it('admits a member creating a session in their own program', async () => {
    const response = await request(member, '/api/ai/sessions', { programId })

    expect(response.status).toBe(201)
  })
})
