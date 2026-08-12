// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

// Vitest does not load .env by itself. Load it here — the config is evaluated
// in the main process before global-setup and before workers fork, so
// DATABASE_URL from .env reaches both. Variables already exported in the
// shell (e.g. CI's DATABASE_URL) take precedence over .env values.
import 'dotenv/config'
import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import viteReact from '@vitejs/plugin-react'

// Filtered by existence: the published core repo has no `packages/enterprise`,
// and naming a missing tsconfig here would fail before a single test ran.
const tsconfigProjects = [
  './packages/core/tsconfig.json',
  './packages/enterprise/tsconfig.json',
].filter((project) => existsSync(project))

export default defineConfig({
  plugins: [viteTsConfigPaths({ projects: tsconfigProjects }), viteReact()],
  test: {
    // Environment
    environment: 'jsdom',

    // Global setup/teardown
    globalSetup: './packages/core/src/__tests__/global-setup.ts',
    setupFiles: ['./packages/core/src/__tests__/setup.ts'],

    // Include patterns. `publish/` is not a package, but the overlay that turns
    // this tree into the public one is exactly the sort of thing that rots
    // unnoticed — nothing else exercises it until a publish.
    include: [
      'packages/*/src/**/*.{test,spec}.{ts,tsx}',
      'publish/*.{test,spec}.ts',
    ],
    exclude: ['node_modules', 'dist', '.output'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: [
        'packages/*/src/lib/**/*.ts',
        'packages/*/src/components/**/*.tsx',
      ],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/*.spec.ts',
        'packages/*/src/__tests__/**',
        'packages/*/src/lib/db/schema/**', // Schema definitions don't need coverage
      ],
      // Coverage is reported but no thresholds are enforced.
      // Revisit once the suite stabilizes post-initial release.
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
      '@test': './packages/core/src/__tests__',
    },
  },
})
