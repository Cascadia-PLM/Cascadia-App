// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * handleApiError — what counts as a database failure
 *
 * Every API route funnels its throws through this function, so it alone
 * decides the code, the status, the message and the log severity a caller
 * sees. To classify a constraint violation it has to reach past drizzle's
 * wrapper to the driver error underneath, and that cause-walk matches anything
 * carrying a string `code` — which node's fs errors and undici's socket errors
 * both do. A missing vault object and a refused RabbitMQ connection therefore
 * came back as DB_QUERY_FAILED, "Database operation failed", logged CRITICAL
 * against a database that was never touched: the wrong code for the client to
 * branch on, and a false entry in the one signal an operator watches.
 *
 * Invariants: a `code` that is not a SQLSTATE is not a database failure, and a
 * code that is one still is. The second half is the point — the cause-walk was
 * added to stop wrapped violations being 500s (pg.test.ts pins it against a
 * real 23505 from the real driver), and narrowing it must not undo that.
 *
 * Run: npx vitest run packages/core/src/lib/errors/handleApiError.test.ts
 */

import { describe, expect, it } from 'vitest'
import { handleApiError } from './handleApiError'
import { ErrorCode } from './codes'
import { errorResponseSchema } from '@/lib/api/openapi-helpers'

/** An errno error, the way node's fs and undici each attach one. */
function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * What drizzle hands up: the failed SQL as the message, the driver error as
 * the cause. Nothing on the wrapper itself says which constraint rejected the
 * statement — that is why the classification walks the chain at all.
 */
function drizzleWrapper(driverError: object): Error {
  const query = 'insert into "users" ("email", "name") values ($1, $2)'
  return Object.assign(
    new Error(`Failed query: ${query}`, { cause: driverError }),
    {
      query,
      params: ['a@b.test', 'Duplicate'],
    },
  )
}

/**
 * Run an error through the handler and read the wire response. The parse is
 * an assertion: a body that is not the documented envelope throws here.
 */
async function classify(error: unknown) {
  const response = handleApiError(error, undefined, 'req-classify')
  const payload: unknown = await response.json()
  const body = errorResponseSchema.parse(payload)
  return {
    status: response.status,
    code: body.error.code,
    message: body.error.message,
  }
}

describe('handleApiError classification', () => {
  it('does not report a missing file as a database failure', async () => {
    // fs shape: the errno error arrives as the cause of whatever wrapped it.
    const result = await classify(
      new Error('could not read the vault object', {
        cause: errnoError(
          "ENOENT: no such file or directory, open 'bracket.step'",
          'ENOENT',
        ),
      }),
    )

    expect(result.status).toBe(500)
    expect(result.code).toBe(ErrorCode.INTERNAL_ERROR)
    expect(result.code).not.toBe(ErrorCode.DB_QUERY_FAILED)
    expect(result.message).toBe('An unexpected error occurred')
  })

  it('does not report a refused connection as a database failure', async () => {
    // undici's fetch shape: a TypeError over the socket error it failed on.
    const result = await classify(
      new TypeError('fetch failed', {
        cause: errnoError(
          'connect ECONNREFUSED 127.0.0.1:5672',
          'ECONNREFUSED',
        ),
      }),
    )

    expect(result.status).toBe(500)
    expect(result.code).toBe(ErrorCode.INTERNAL_ERROR)
    expect(result.code).not.toBe(ErrorCode.DB_QUERY_FAILED)
    expect(result.message).toBe('An unexpected error occurred')
  })

  it('still maps a wrapped unique violation to a 409', async () => {
    const result = await classify(
      drizzleWrapper({
        code: '23505',
        detail: 'Key (email)=(a@b.test) already exists.',
        constraint_name: 'users_email_unique',
        table_name: 'users',
      }),
    )

    expect(result.status).toBe(409)
    expect(result.code).toBe(ErrorCode.RESOURCE_ALREADY_EXISTS)
    expect(result.message).toBe('Key (email)=(a@b.test) already exists.')
  })

  it('still maps a wrapped serialization failure to a retryable conflict', async () => {
    const result = await classify(drizzleWrapper({ code: '40001' }))

    expect(result.status).toBe(500)
    expect(result.code).toBe(ErrorCode.DB_TRANSACTION_FAILED)
  })

  it('keeps DB_QUERY_FAILED for a SQLSTATE nothing maps by name', async () => {
    // The gate narrows what reaches the code table; it does not empty the
    // table's default branch. 22P02 is invalid_text_representation.
    const result = await classify(drizzleWrapper({ code: '22P02' }))

    expect(result.status).toBe(500)
    expect(result.code).toBe(ErrorCode.DB_QUERY_FAILED)
    // The statement and its bound parameters stay out of the response.
    expect(result.message).toBe('Database operation failed')
  })
})
