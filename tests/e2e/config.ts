/**
 * E2E Test Configuration
 *
 * Shared configuration for E2E tests. This file can be imported
 * by both fixtures and setup files.
 */

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
