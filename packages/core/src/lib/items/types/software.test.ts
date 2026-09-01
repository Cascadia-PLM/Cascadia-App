// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, it } from 'vitest'
import { softwareSchema, softwareSourceSchema } from './software'

describe('Software external source metadata', () => {
  it('allows external mode without repository metadata', () => {
    expect(
      softwareSchema.safeParse({
        itemType: 'Software',
        designId: '00000000-0000-4000-8000-000000000001',
        sourceMode: 'external',
      }).success,
    ).toBe(true)

    expect(
      softwareSourceSchema.safeParse({ sourceMode: 'external' }).success,
    ).toBe(true)
  })

  it('still validates external metadata when supplied', () => {
    expect(
      softwareSourceSchema.safeParse({
        sourceMode: 'external',
        externalRepositoryUrl: 'file:///tmp/repository',
      }).success,
    ).toBe(false)

    expect(
      softwareSourceSchema.safeParse({
        sourceMode: 'external',
        externalCommitSha: 'not-a-full-sha',
      }).success,
    ).toBe(false)
  })

  it('normalizes blank optional metadata to null', () => {
    const result = softwareSourceSchema.parse({
      sourceMode: 'external',
      externalRepositoryUrl: ' ',
      externalRef: '',
      externalCommitSha: ' ',
    })

    expect(result).toMatchObject({
      externalRepositoryUrl: null,
      externalRef: null,
      externalCommitSha: null,
    })
  })
})
