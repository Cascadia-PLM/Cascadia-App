// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { ErrorCode } from '@cascadia/commons/errors/codes'
import { ApiError, apiErrorFromResponse } from './client'

describe('apiErrorFromResponse', () => {
  it('preserves the standard API error envelope', async () => {
    const error = await apiErrorFromResponse(
      new Response(
        JSON.stringify({
          error: {
            code: ErrorCode.FILE_TYPE_NOT_ALLOWED,
            message: "File type '.bad' is not allowed",
            fieldErrors: [{ field: 'file', message: 'Unsupported extension' }],
            requestId: 'request-1',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        }),
        { status: 415 },
      ),
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      code: ErrorCode.FILE_TYPE_NOT_ALLOWED,
      message: "File type '.bad' is not allowed",
      httpStatus: 415,
      fieldErrors: [{ field: 'file', message: 'Unsupported extension' }],
      requestId: 'request-1',
    })
  })

  it('never coerces structured error fields to object text', async () => {
    const error = await apiErrorFromResponse(
      new Response(
        JSON.stringify({ error: { details: { reason: 'invalid' } } }),
        { status: 400 },
      ),
      'Upload failed',
    )

    expect(error.message).toBe('Upload failed')
    expect(error.message).not.toBe('[object Object]')
  })

  it('supports a legacy top-level string error', async () => {
    const error = await apiErrorFromResponse(
      new Response(JSON.stringify({ error: 'Legacy failure' }), {
        status: 400,
      }),
      'Fallback',
    )

    expect(error.message).toBe('Legacy failure')
  })
  it('preserves validation messages for the whole request body', async () => {
    const error = await apiErrorFromResponse(
      new Response(
        JSON.stringify({
          error: {
            code: ErrorCode.VALIDATION_FAILED,
            message: 'Validation failed',
            fieldErrors: [
              {
                field: '',
                message: 'Provide either perUnit or requiredCount, not both',
              },
            ],
          },
        }),
        { status: 400 },
      ),
    )

    expect(error.fieldErrors).toEqual([
      {
        field: '',
        message: 'Provide either perUnit or requiredCount, not both',
      },
    ])
  })

  it('preserves server error codes unknown to this client build', async () => {
    const error = await apiErrorFromResponse(
      new Response(
        JSON.stringify({
          error: {
            code: 'CONNECTION_ERROR',
            message: 'Provider connection failed',
          },
        }),
        { status: 502 },
      ),
    )

    expect(error).toMatchObject({
      code: 'CONNECTION_ERROR',
      message: 'Provider connection failed',
      httpStatus: 502,
    })
  })
})
