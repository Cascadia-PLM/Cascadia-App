/**
 * Test Helpers Index
 *
 * Central export for all test utilities.
 *
 * @example
 * ```typescript
 * import {
 *   // Database
 *   TestDatabase,
 *   setupTestDb,
 *   testQueries,
 *
 *   // Auth
 *   createMockRequest,
 *   createMockSession,
 *   mockAuth,
 *   setupAuthMocks,
 *   authAssertions,
 *
 *   // API
 *   createApiTestClient,
 *   apiAssertions,
 *   createServiceMocks,
 *
 *   // Vault
 *   MockVaultStorage,
 *   createTestFile,
 *   VaultTestHelper,
 *   createFileServiceMocks,
 *   vaultAssertions,
 *
 *   // React rendering
 *   renderWithProviders,
 *   screen,
 *   userEvent,
 *   testUsers,
 *   testPermissions,
 * } from '@test/helpers'
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

// Auth utilities
export {
  createMockSession,
  createMockRequest,
  createAuthenticatedRequest,
  getPermissionsForRole,
  getPermissionsForRoles,
  hasPermission,
  setupAuthMocks,
  mockAuth,
  isAuthError,
  parseAuthError,
  authAssertions,
  type MockSessionValidationResult,
  type MockRequestOptions,
  type MockAuthOptions,
} from './auth'

// API utilities
export {
  ApiTestClient,
  createApiTestClient,
  apiAssertions,
  createServiceMocks,
  expectApiError,
  expectValidationErrors,
  type HttpMethod,
  type ApiTestRequestOptions,
  type ApiTestResponse,
} from './api'

// Vault utilities
export {
  MockVaultStorage,
  createTestFile,
  createTestFileMetadata,
  filePresets,
  VaultTestHelper,
  createFileServiceMocks,
  vaultAssertions,
} from './vault'

// React rendering utilities
export {
  renderWithProviders,
  renderWithRouter,
  useTestToasts,
  useTestAuth,
  useTestTheme,
  waitForUpdates,
  createMockEvent,
  testUsers,
  testPermissions,
  // Re-exports from @testing-library/react
  screen,
  fireEvent,
  waitFor,
  within,
  act,
  // Re-export userEvent
  userEvent,
  type RenderWithProvidersOptions,
  type TestUserContext,
} from './render'
