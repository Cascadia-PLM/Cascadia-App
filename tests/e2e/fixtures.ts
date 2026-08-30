// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Playwright Test Fixtures
 *
 * The suite signs in exactly once, in `global.setup.ts`, which saves the
 * browser state to `AUTH_STATE_PATH`. The `chromium` project loads that file
 * as `storageState`, so a test's `page` arrives already authenticated and with
 * the product tour suppressed.
 *
 * `authenticatedPage` is therefore only a named entry point: it lands on the
 * dashboard so specs do not each repeat that first navigation. It exists
 * because every spec already asks for it; it is not where authentication
 * happens.
 *
 * It used to be. The fixture checked the freshness of the shared state file,
 * logged in when it looked stale, and wrote the file back — per test. With one
 * worker that is merely wasteful; with N it is N concurrent logins racing N
 * writes to one path, which is the "login race conditions" the config pinned
 * `workers: 1` for. Do not reintroduce a login here.
 *
 * A spec that needs to start signed out opts back out with
 * `test.use({ storageState: { cookies: [], origins: [] } })` — see
 * `auth.spec.ts` and `rendering.spec.ts`.
 */

import { test as base } from '@playwright/test'
import type { Page } from '@playwright/test'

type CustomFixtures = {
  authenticatedPage: Page
}

export const test = base.extend<CustomFixtures>({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/')
    await use(page)
  },
})

/**
 * Re-export expect from base for convenience
 */
export { expect } from '@playwright/test'
