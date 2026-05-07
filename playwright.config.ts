/**
 * Playwright E2E Test Configuration
 *
 * For more information, see: https://playwright.dev/docs/test-configuration
 */

import { defineConfig, devices } from '@playwright/test'

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

  /* Use single worker for stability (parallel causes login race conditions) */
  workers: 1,

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
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',

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
    url: 'http://localhost:3000/api/v1/health',
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
