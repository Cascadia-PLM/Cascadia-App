// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * E2E Test Configuration
 *
 * Shared configuration for E2E tests. This file can be imported
 * by both fixtures and setup files.
 */

/**
 * Where the signed-in browser state is written.
 *
 * `global.setup.ts` logs in once and saves here; the `chromium` project loads
 * it as `storageState`, so every test starts authenticated without logging in
 * itself. Relative to `process.cwd()` because tests run from the project root
 * and this file has to resolve the same way under ESM.
 */
export const AUTH_STATE_PATH = 'playwright/.auth/user.json'

/**
 * Test user configuration
 *
 * Uses the default admin account created by the seed script.
 * For E2E tests, we use username-based login (not email).
 */
export const E2E_TEST_CONFIG = {
  // Default admin user (created by seed script)
  adminUser: {
    username: 'admin@cascadia.local',
    password: 'Cascadia',
    name: 'Admin User',
  },
  // Standard user (if available from seed)
  standardUser: {
    username: 'user@cascadia.local',
    password: 'Cascadia',
    name: 'Standard User',
  },
}
