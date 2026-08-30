// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Playwright E2E Test Configuration
 *
 * For more information, see: https://playwright.dev/docs/test-configuration
 */

import { defineConfig, devices } from '@playwright/test'
import { AUTH_STATE_PATH } from './tests/e2e/config'

/**
 * The dev server this run drives, and the URL it is reached at.
 *
 * `CLIENT_PORT` is the same variable `scripts/dev.mjs` reads, so the server
 * Playwright starts and the URL it waits on cannot disagree. Both were 3000,
 * hardcoded in two files, which meant one checkout per machine: a second
 * worktree running `npm run dev` made every E2E run here fail before starting a
 * single test, with `already used, make sure that nothing is running`.
 */
const CLIENT_PORT = process.env.CLIENT_PORT ?? '3000'
const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${CLIENT_PORT}`

/**
 * Read environment variables from .env file
 * See: https://github.com/motdotla/dotenv
 */
// require('dotenv').config()

export default defineConfig({
  /* Test directory */
  testDir: './tests/e2e',

  /* Output directory for test artifacts */
  outputDir: './test-results',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry failed tests */
  retries: process.env.CI ? 2 : 1,

  /*
   * The suite signs in once in the setup project and every test restores that
   * state, so there is no longer a per-test login to race. `workers: 1` was
   * pinned because the old fixture logged in per test and wrote the shared
   * state file from each worker; with that gone, the specs are independent
   * journeys against distinct data and run in parallel.
   *
   * CI is pinned to 2 rather than left to the runner's core count: the same
   * container runs Postgres and the dev server, and the value that matters is
   * the one measured there, not the one a bigger machine could sustain.
   */
  workers: process.env.CI ? 2 : undefined,

  /* Reporter configuration */
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
      ]
    : [
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'test-results/results.json' }],
      ],

  /* Shared settings for all the projects below */
  use: {
    /* Base URL for navigation actions */
    baseURL: BASE_URL,

    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',

    /* Take screenshot on failure */
    screenshot: 'only-on-failure',

    /* Record video on failure */
    video: 'retain-on-failure',

    /* Maximum time each action can take */
    actionTimeout: 10000,

    /* Maximum time each navigation can take */
    navigationTimeout: 30000,
  },

  /* Configure projects for major browsers */
  projects: [
    /* Setup project - runs before all tests */
    {
      name: 'setup',
      testMatch: /global\.setup\.ts/,
      teardown: 'teardown',
    },

    /* Teardown project - runs after all tests */
    {
      name: 'teardown',
      testMatch: /global\.teardown\.ts/,
    },

    /* Desktop Chrome */
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /*
         * Signed in, courtesy of the setup project. A spec that needs a signed
         * out browser overrides this per file with
         * `test.use({ storageState: { cookies: [], origins: [] } })`.
         */
        storageState: AUTH_STATE_PATH,
      },
      dependencies: ['setup'],
    },

    /* Desktop Firefox - enable in CI or when browser is installed */
    // {
    //   name: 'firefox',
    //   use: {
    //     ...devices['Desktop Firefox'],
    //   },
    //   dependencies: ['setup'],
    // },

    /* Desktop Safari - enable in CI or when browser is installed */
    // {
    //   name: 'webkit',
    //   use: {
    //     ...devices['Desktop Safari'],
    //   },
    //   dependencies: ['setup'],
    // },

    /* Mobile Chrome */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    //   dependencies: ['setup'],
    // },

    /* Mobile Safari */
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    //   dependencies: ['setup'],
    // },
  ],

  /* Run dev servers before starting the tests.
   * Uses the health endpoint via proxy to ensure both Vite AND Hono are ready. */
  webServer: {
    command: 'npm run dev',
    url: `${BASE_URL}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },

  /* Test timeout - increased for stability */
  timeout: 60000,

  /* Expect timeout - increased for React rendering */
  expect: {
    timeout: 10000,
  },

  /* Global test timeout */
  globalTimeout: process.env.CI ? 60 * 60 * 1000 : undefined, // 1 hour on CI
})
