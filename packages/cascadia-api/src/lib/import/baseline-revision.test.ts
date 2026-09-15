// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { parseBaselineReleaseRevision } from './baseline-revision'
import type { RevisionScheme } from '@/lib/types/lifecycle'
import { ValidationError } from '@/lib/errors'

describe('parseBaselineReleaseRevision', () => {
  it('accepts revisions that match the configured release scheme', () => {
    expect(parseBaselineReleaseRevision(' B ', { type: 'alpha' })).toBe('B')
    expect(parseBaselineReleaseRevision('4', { type: 'numeric' })).toBe('4')
    expect(
      parseBaselineReleaseRevision('R4', {
        type: 'prefixed-numeric',
        prefix: 'R',
      }),
    ).toBe('R4')
    expect(parseBaselineReleaseRevision('N/A', { type: 'none' })).toBe('N/A')
  })

  it.each(['', '-', '-abc12345', 'DRAFT'])(
    'rejects working revision %j',
    (revision) => {
      expect(() =>
        parseBaselineReleaseRevision(revision, { type: 'alpha' }),
      ).toThrow(ValidationError)
    },
  )

  it('rejects a revision from another scheme', () => {
    expect(() => parseBaselineReleaseRevision('R4', { type: 'alpha' })).toThrow(
      /expected A, B/,
    )
    expect(() =>
      parseBaselineReleaseRevision('4', {
        type: 'prefixed-numeric',
        prefix: 'R',
      }),
    ).toThrow(/expected R1/)
  })

  it('honors a configured zero-based starting revision', () => {
    const scheme = { type: 'numeric', startAt: 0 } as RevisionScheme

    expect(parseBaselineReleaseRevision('0', scheme)).toBe('0')
  })
})
