// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `classifyMigrationState` — what the container decides at boot.
 *
 * Data-integrity gate: this is the branch that decides whether DDL runs against
 * a live database unattended. Getting it wrong in one direction replays a
 * baseline over an operator's tables; in the other it refuses to start a fresh
 * install, which is a crash-loop nobody can diagnose from the outside.
 *
 * Run: npx vitest run scripts/boot-migrate.test.ts
 */

import { describe, expect, it } from 'vitest'
import { classifyMigrationState } from './boot-migrate-state'

const SCHEMA_TABLES = ['items', 'users', 'programs']

describe('classifyMigrationState', () => {
  it('migrates an empty database — a fresh install applies the baseline', () => {
    expect(classifyMigrationState(0, new Set(), SCHEMA_TABLES)).toBe('migrate')
  })

  it('migrates a database whose journal is current', () => {
    expect(
      classifyMigrationState(4, new Set(SCHEMA_TABLES), SCHEMA_TABLES),
    ).toBe('migrate')
  })

  it('refuses a pre-0.5 database: tables, but nothing in the journal', () => {
    expect(
      classifyMigrationState(0, new Set(SCHEMA_TABLES), SCHEMA_TABLES),
    ).toBe('refuse')
  })

  it('refuses on a partially-created database too', () => {
    // Not a state anything produces on purpose, but replaying a baseline over
    // it is no safer than over a complete one.
    expect(classifyMigrationState(0, new Set(['items']), SCHEMA_TABLES)).toBe(
      'refuse',
    )
  })

  it('ignores tables the schema does not define', () => {
    // A database holding only something else's tables — a shared Postgres, say
    // — is empty as far as this schema is concerned.
    expect(
      classifyMigrationState(0, new Set(['flyway_history']), SCHEMA_TABLES),
    ).toBe('migrate')
  })
})
