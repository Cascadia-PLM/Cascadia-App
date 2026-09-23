// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Test Helpers Index
 *
 * Central export for the database test harnesses. Most suites import the
 * concrete module directly (`@test/helpers/db`); this barrel exists for the
 * few that prefer the short path.
 *
 * @example
 * ```typescript
 * import { TestDatabase } from '@test/helpers'
 * ```
 */

// Database utilities
export {
  TestDatabase,
  setupTestDb,
  getTestDatabase,
  testQueries,
  type TestDatabaseConfig,
} from './db'

// The multi-connection variant, for tests about races rather than about
// behaviour. It commits — see its header before reaching for it.
export { ConcurrentTestDatabase, type SeededScope } from './concurrent-db'
