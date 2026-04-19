import { defineConfig } from 'vitest/config'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    viteReact(),
  ],
  test: {
    // Environment
    environment: 'jsdom',

    // Global setup/teardown
    globalSetup: './src/__tests__/global-setup.ts',
    setupFiles: ['./src/__tests__/setup.ts'],

    // Include patterns
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist', '.output'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/lib/**/*.ts', 'src/components/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/__tests__/**',
        'src/lib/db/schema/**', // Schema definitions don't need coverage
      ],
      // Coverage is reported but no thresholds are enforced.
      // Revisit once the suite stabilizes post-open-source release.
    },

    // Reporter configuration
    reporters: ['default', 'html'],

    // Pool configuration - each test file runs in its own forked process
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },

    // Timeouts - 30s accommodates integration tests with heavy DB setup
    testTimeout: 30000,
    hookTimeout: 30000,

    // Type checking
    typecheck: {
      enabled: false, // Enable via --typecheck flag when needed
    },

    // Globals (describe, it, expect, etc.)
    globals: true,

    // Mock configuration
    mockReset: true,
    restoreMocks: true,

    // Alias for test utilities
    alias: {
      '@test': './src/__tests__',
    },
  },
})
