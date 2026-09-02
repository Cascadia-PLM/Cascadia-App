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

// Filtered by existence: the published core repo has none of the module
// packages,
// and naming a missing tsconfig here would fail before a single test ran.
const tsconfigProjects = [
  './packages/core/tsconfig.json',
  './packages/advanced-auditing/tsconfig.json',
  './packages/design-engine/tsconfig.json',
  './packages/odoo-integration/tsconfig.json',
].filter((project) => existsSync(project))

export default defineConfig({
  plugins: [viteTsConfigPaths({ projects: tsconfigProjects }), viteReact()],
  test: {
    // Two projects, split by environment (TEST-4). The suite is ~97% service
    // and route tests that never touch a DOM; only the .test.tsx component
    // files get jsdom. The split is the file extension — name a component
    // test `.test.tsx` or it runs under node and `document` is undefined.
    // Include patterns: `publish/` is not a package, but the overlay that
    // turns this tree into the public one is exactly the sort of thing that
    // rots unnoticed — nothing else exercises it until a publish. `scripts/`
    // is there for the same reason.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          setupFiles: ['./packages/core/src/__tests__/setup.node.ts'],
          include: [
            'packages/*/src/**/*.{test,spec}.ts',
            'publish/*.{test,spec}.ts',
            // Recursive, and `.mjs` as well as `.ts`, so the two hand-written
            // ESLint rules' RuleTester suites run. They sit in
            // `scripts/eslint-rules/` and are `.mjs` because the rules they
            // test are, and the previous glob — top level, TypeScript — could
            // match neither. `no-indirect-effect-fetch.test.mjs` was therefore
            // written, committed, and executed by nothing: a test held up as
            // the gate on a lint rule, which nothing ran. Both suites pass
            // standalone under `node` too; RuleTester registers through global
            // describe/it when they exist and runs inline when they do not.
            'scripts/**/*.{test,spec}.{ts,mjs}',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./packages/core/src/__tests__/setup.dom.ts'],
          include: ['packages/*/src/**/*.{test,spec}.tsx'],
        },
      },
    ],

    // Global setup/teardown (root-level: runs once, before any project)
    globalSetup: './packages/core/src/__tests__/global-setup.ts',

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

    // Pool configuration - each test file runs in its own forked process.
    // Vitest 4 removed `poolOptions`; the `forks.singleFork: false` that used
    // to sit here was already the default (one fork per file, run in
    // parallel), so dropping it changes nothing. Set `maxWorkers: 1` plus
    // `isolate: false` if a single shared fork is ever wanted again.
    pool: 'forks',

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
