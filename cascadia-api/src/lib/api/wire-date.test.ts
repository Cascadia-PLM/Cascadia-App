// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { clearableDate } from './wire-date'
import type { z } from 'zod'
import { programUpdateSchema } from '@/lib/services/ProgramService'

/**
 * The invariant is that the three wire spellings of "no date" stay distinct in
 * exactly one respect: `undefined` means "leave the column alone" and the
 * other two mean "clear it". Both halves were broken before — `''` was a 400
 * and `null` was silently the Unix epoch — and neither failure is visible by
 * reading `z.coerce.date().optional()`.
 */
describe('clearableDate', () => {
  const schema = clearableDate().optional()

  it('reads an emptied date input as no date, not as an invalid one', () => {
    expect(schema.parse('')).toBeNull()
  })

  it('reads an explicit null as no date, not as the Unix epoch', () => {
    expect(schema.parse(null)).toBeNull()
  })

  it('leaves an omitted field omitted, so a partial update skips it', () => {
    expect(schema.parse(undefined)).toBeUndefined()
  })

  it('still coerces the date forms a client actually sends', () => {
    expect(schema.parse('2026-01-01')).toEqual(new Date('2026-01-01'))
    expect(schema.parse('2026-01-01T05:00:00.000Z')).toEqual(
      new Date('2026-01-01T05:00:00.000Z'),
    )
    const now = new Date()
    expect(schema.parse(now)).toEqual(now)
  })

  it('rejects a value that is not a date at all', () => {
    const result = schema.safeParse('not a date')
    expect(result.success).toBe(false)
  })
})

describe('programUpdateSchema dates', () => {
  it('accepts the payload the program edit form sends for an undated program', () => {
    // Every field the page sends, with both dates unset — the exact shape
    // that made Save fail on every program in a fresh database.
    const parsed = programUpdateSchema.parse({
      code: 'PUC',
      name: 'Powered Utility Cart Program',
      description: '',
      status: 'Active',
      customer: '',
      contractNumber: '',
      startDate: null,
      targetEndDate: null,
      attributes: {},
    })
    expect(parsed.startDate).toBeNull()
    expect(parsed.targetEndDate).toBeNull()
  })

  it('accepts the empty strings an older client sends for the same thing', () => {
    const parsed = programUpdateSchema.parse({
      startDate: '',
      targetEndDate: '',
    })
    expect(parsed.startDate).toBeNull()
    expect(parsed.targetEndDate).toBeNull()
  })

  it('names the offending field when a date really is malformed', () => {
    const result = programUpdateSchema.safeParse({ startDate: 'yesterday' })
    expect(result.success).toBe(false)
    const issues = (result as z.ZodSafeParseError<unknown>).error.issues
    expect(issues[0]?.path).toEqual(['startDate'])
    expect(issues[0]?.message).toBe('Invalid date')
  })
})
