// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * MCP endpoint — security-gate tests
 *
 * The /api/mcp endpoint hands external agents the PLM tool set, so its
 * authentication and scoping behavior is a security boundary. These tests
 * pin the invariants:
 *
 *  - no credentials, an invalid key, or an expired key → 401
 *  - a *valid browser session cookie* is still rejected: the endpoint is
 *    API-key only, which is what removes its CSRF surface
 *  - tools/list never exposes UI-coupled tools (offer_navigation,
 *    initiate_collaborative_design) to external agents
 *  - a scoped API key narrows tool access (read allowed, write denied)
 *    even when the user's role would allow the write
 *  - a full-scope key cannot widen access beyond the user's roles
 *  - write tools do not mutate without a redeemed confirmation token
 *
 * Two schema-contract invariants ride along, because the tool schema is the
 * only thing an external agent can see:
 *
 *  - tool enums never advertise a value the item type's schema rejects
 *  - a write that fails validation names the offending field
 *
 * Run: npx vitest run src/server/routes/mcp.test.ts
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
import { Hono } from 'hono'
import mcpRoutes from './mcp'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { SessionManager } from '@/lib/auth/session'
import { permissionService } from '@/lib/auth/permission-service'
import {
  generateApiKey,
  getKeyPrefix,
  hashApiKey,
} from '@/lib/auth/api-key-utils'
import { apiKeys } from '@/lib/db/schema/api-keys'
import { ITEM_TYPE_DEFINITIONS } from '@/lib/items/item-type-definitions'
import { changeOrderTypeSchema } from '@/lib/items/types/change-order'
import { partTypeSchema } from '@/lib/items/types/part'
import { requirementTypeSchema } from '@/lib/items/types/requirement'
import { taskPrioritySchema } from '@/lib/items/types/task'

// Import to register item types (read tools reach the item services)
import '@/lib/items/registerItemTypes.server'

interface ToolListing {
  name: string
  inputSchema?: {
    properties?: Record<string, { enum?: Array<string> }>
  }
}

interface JsonRpcResponse {
  jsonrpc: string
  id: number | string | null
  result?: {
    serverInfo?: { name: string }
    tools?: Array<ToolListing>
    isError?: boolean
    content?: Array<{ type: string; text: string }>
    structuredContent?: Record<string, unknown>
  }
  error?: { code: number; message: string }
}

describe('MCP endpoint — authentication and scoping gates', () => {
  const testDb = new TestDatabase()
  const app = new Hono().route('/api/mcp', mcpRoutes)

  let admin: TestUser
  let viewer: TestUser

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    permissionService.clearCache()

    admin = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    viewer = (await insertTestUserWithRole(testDb.db, 'View Only')).user
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function mintKey(
    userId: string,
    scope: Record<string, Array<string>> | null = null,
    expiresAt: Date | null = null,
  ): Promise<string> {
    const rawKey = generateApiKey()
    await testDb.db.insert(apiKeys).values({
      userId,
      name: 'test key',
      keyHash: hashApiKey(rawKey),
      keyPrefix: getKeyPrefix(rawKey),
      permissions: scope,
      expiresAt,
    })
    return rawKey
  }

  async function rpc(
    body: object,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  }

  function listToolsRequest() {
    return { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  }

  function callToolRequest(name: string, args: Record<string, unknown>) {
    return {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }
  }

  // ── Authentication ────────────────────────────────────────────────────

  it('rejects unauthenticated requests with 401 and WWW-Authenticate', async () => {
    const res = await rpc(listToolsRequest())
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer')
  })

  it('rejects a valid session cookie — the endpoint is API-key only', async () => {
    const { sessionToken } = await SessionManager.createSession(admin.id)
    const res = await rpc(listToolsRequest(), {
      Cookie: `session=${sessionToken}`,
    })
    expect(res.status).toBe(401)
  })

  it('rejects an invalid API key', async () => {
    const res = await rpc(listToolsRequest(), {
      Authorization: `Bearer csc_${'0'.repeat(40)}`,
    })
    expect(res.status).toBe(401)
  })

  it('rejects an expired API key', async () => {
    const key = await mintKey(admin.id, null, new Date(Date.now() - 60_000))
    const res = await rpc(listToolsRequest(), {
      Authorization: `Bearer ${key}`,
    })
    expect(res.status).toBe(401)
  })

  // ── Tool surface ──────────────────────────────────────────────────────

  it('lists PLM tools but never UI-coupled tools', async () => {
    const key = await mintKey(admin.id)
    const res = await rpc(listToolsRequest(), {
      Authorization: `Bearer ${key}`,
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as JsonRpcResponse
    const names = (body.result?.tools ?? []).map((t) => t.name)

    expect(names).toContain('search_items')
    expect(names).toContain('get_bom')
    expect(names).toContain('create_change_order')
    // SPA-only tools must not leak to external agents
    expect(names).not.toContain('offer_navigation')
    expect(names).not.toContain('initiate_collaborative_design')
  })

  it('auto-registers every item type in the tool schemas', async () => {
    const key = await mintKey(admin.id)
    const res = await rpc(listToolsRequest(), {
      Authorization: `Bearer ${key}`,
    })
    const body = (await res.json()) as JsonRpcResponse
    const tools = body.result?.tools ?? []

    const allTypeNames = Object.values(ITEM_TYPE_DEFINITIONS).map(
      (def) => def.name,
    )
    expect(allTypeNames.length).toBeGreaterThanOrEqual(13)

    // search_items covers every registered item type
    const searchEnum =
      tools.find((t) => t.name === 'search_items')?.inputSchema?.properties
        ?.itemType?.enum ?? []
    for (const typeName of allTypeNames) {
      expect(searchEnum, `search_items is missing ${typeName}`).toContain(
        typeName,
      )
    }

    // create_item covers every type except ChangeOrder (dedicated tool)
    const createEnum =
      tools.find((t) => t.name === 'create_item')?.inputSchema?.properties
        ?.itemType?.enum ?? []
    for (const typeName of allTypeNames.filter((n) => n !== 'ChangeOrder')) {
      expect(createEnum, `create_item is missing ${typeName}`).toContain(
        typeName,
      )
    }
    expect(createEnum).not.toContain('ChangeOrder')
  })

  it('advertises only field values the item schemas accept', async () => {
    // A tool enum that disagrees with the schema validating the write is a
    // trap the agent cannot see: the call fails inside ItemService with a
    // bare "Validation failed" and no field name, so the model retries the
    // same rejected value. create_item once offered requirementType
    // Interface/Constraint/Other (all rejected) and lowercase task
    // priorities (all rejected), and create_change_order hid XCO.
    const key = await mintKey(admin.id)
    const res = await rpc(listToolsRequest(), {
      Authorization: `Bearer ${key}`,
    })
    const body = (await res.json()) as JsonRpcResponse
    const tools = body.result?.tools ?? []

    const enumOf = (tool: string, field: string) =>
      tools.find((t) => t.name === tool)?.inputSchema?.properties?.[field]?.enum

    // Expectations come from the item type schemas, not repeated literals —
    // restating the values here would just relocate the drift.
    expect(enumOf('create_item', 'requirementType')).toEqual([
      ...requirementTypeSchema.options,
    ])
    expect(enumOf('create_item', 'partType')).toEqual([
      ...partTypeSchema.options,
    ])
    expect(enumOf('create_item', 'priority')).toEqual([
      ...taskPrioritySchema.options,
    ])
    expect(enumOf('update_item', 'partType')).toEqual([
      ...partTypeSchema.options,
    ])
    expect(enumOf('update_item', 'priority')).toEqual([
      ...taskPrioritySchema.options,
    ])
    expect(enumOf('create_change_order', 'changeType')).toEqual([
      ...changeOrderTypeSchema.options,
    ])
  })

  // ── Permission scoping ────────────────────────────────────────────────

  it('scoped key: read tools work, write tools are denied despite an admin role', async () => {
    const key = await mintKey(admin.id, { parts: ['read'] })

    const readRes = await rpc(
      callToolRequest('search_items', { query: 'anything' }),
      { Authorization: `Bearer ${key}` },
    )
    const readBody = (await readRes.json()) as JsonRpcResponse
    expect(readBody.result?.isError).toBeFalsy()

    const writeRes = await rpc(
      callToolRequest('create_item', {
        itemType: 'Part',
        name: 'Scoped-key part',
        confirmed: true,
      }),
      { Authorization: `Bearer ${key}` },
    )
    const writeBody = (await writeRes.json()) as JsonRpcResponse
    expect(writeBody.result?.isError).toBe(true)
    expect(writeBody.result?.content?.[0]?.text).toMatch(/permission denied/i)
  })

  it('create_item permission follows the requested item type', async () => {
    // Key scoped to parts only: creating a Part passes the permission gate
    // (returns the confirmation step), but creating a Document is denied —
    // the check maps to documents:create, not a blanket parts:create.
    const key = await mintKey(admin.id, { parts: ['read', 'create'] })

    const partRes = await rpc(
      callToolRequest('create_item', {
        itemType: 'Part',
        name: 'Typed-permission part',
      }),
      { Authorization: `Bearer ${key}` },
    )
    const partBody = (await partRes.json()) as JsonRpcResponse
    expect(partBody.result?.isError).toBeFalsy()
    expect(partBody.result?.structuredContent?.requiresConfirmation).toBe(true)

    const docRes = await rpc(
      callToolRequest('create_item', {
        itemType: 'Document',
        name: 'Typed-permission document',
        confirmed: true,
      }),
      { Authorization: `Bearer ${key}` },
    )
    const docBody = (await docRes.json()) as JsonRpcResponse
    expect(docBody.result?.isError).toBe(true)
    expect(docBody.result?.content?.[0]?.text).toMatch(/documents/i)
  })

  it('full-scope key cannot widen access beyond the user roles', async () => {
    const key = await mintKey(viewer.id)

    const res = await rpc(
      callToolRequest('create_item', {
        itemType: 'Part',
        name: 'Viewer part',
        confirmed: true,
      }),
      { Authorization: `Bearer ${key}` },
    )
    const body = (await res.json()) as JsonRpcResponse
    expect(body.result?.isError).toBe(true)
    expect(body.result?.content?.[0]?.text).toMatch(/permission denied/i)
  })

  // ── Write confirmation flow ───────────────────────────────────────────

  it('write tools preview (with a token) before mutating; legacy confirmed=true gets the same preview', async () => {
    const key = await mintKey(admin.id)

    const res = await rpc(
      callToolRequest('create_item', {
        itemType: 'Part',
        name: 'Unconfirmed part',
      }),
      { Authorization: `Bearer ${key}` },
    )
    const body = (await res.json()) as JsonRpcResponse
    expect(body.result?.isError).toBeFalsy()
    expect(body.result?.structuredContent?.requiresConfirmation).toBe(true)
    expect(body.result?.structuredContent?.confirmationToken).toBeTruthy()
    // Nothing was created on the unconfirmed pass
    expect(body.result?.structuredContent?.itemId).toBeUndefined()

    // The old model-supplied flag no longer executes anything — it degrades
    // to a fresh preview (AI-3).
    const legacyRes = await rpc(
      callToolRequest('create_item', {
        itemType: 'Part',
        name: 'Unconfirmed part',
        confirmed: true,
      }),
      { Authorization: `Bearer ${key}` },
    )
    const legacyBody = (await legacyRes.json()) as JsonRpcResponse
    expect(legacyBody.result?.structuredContent?.requiresConfirmation).toBe(
      true,
    )
    expect(legacyBody.result?.structuredContent?.itemId).toBeUndefined()
  })

  it('names the offending field when a write fails validation', async () => {
    // A write tool reports failures in its own response, not as a protocol
    // error, so the response text is the agent's only diagnostic. Reporting
    // ValidationError's bare message drops the fieldErrors it carries and
    // leaves "Validation failed" — the model cannot tell which argument was
    // wrong and retries the same call.
    const key = await mintKey(admin.id)

    // Two-step flow: take the preview's token, then execute with it.
    const params = {
      itemType: 'Requirement',
      name: 'Requirement with no design',
    }
    const previewRes = await rpc(callToolRequest('create_item', params), {
      Authorization: `Bearer ${key}`,
    })
    const previewBody = (await previewRes.json()) as JsonRpcResponse
    const confirmationToken =
      previewBody.result?.structuredContent?.confirmationToken
    expect(confirmationToken).toBeTruthy()

    const res = await rpc(
      callToolRequest('create_item', { ...params, confirmationToken }),
      { Authorization: `Bearer ${key}` },
    )
    const body = (await res.json()) as JsonRpcResponse
    const error = body.result?.structuredContent?.error

    expect(body.result?.structuredContent?.success).toBe(false)
    expect(error).toContain('designId')
    expect(error).not.toBe('Validation failed')
  })
})
