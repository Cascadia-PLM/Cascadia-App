// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Global Setup for Playwright E2E Tests
 *
 * Runs once before all E2E tests to:
 * - Verify application is accessible
 * - Verify login page loads correctly
 * - Sign in once and save the browser state every other test reuses
 * - Guarantee the seed data the lifecycle specs hard-require
 *
 * Prerequisites (run before tests):
 *   npm run db:reset:seed  # Reset and seed database
 *   npm run dev            # Start dev server
 *
 * Or use the full command:
 *   npm run test:e2e:full
 */

import { expect, test as setup } from '@playwright/test'
import { AUTH_STATE_PATH, E2E_TEST_CONFIG } from './config'

setup('global setup', async ({ page, context }) => {
  console.log('')
  console.log('═'.repeat(60))
  console.log('  E2E GLOBAL SETUP')
  console.log('═'.repeat(60))
  console.log('')

  // Step 1: Verify the app is accessible
  console.log('Step 1: Verifying application is accessible...')

  try {
    await page.goto('/')

    // Should redirect to login if not authenticated
    await expect(page).toHaveURL(/.*login.*/)

    console.log('  ✓ Application is accessible and redirecting to login')
  } catch (error) {
    console.error('  ✗ Failed to access application:', error)
    console.error('')
    console.error('  Make sure the dev server is running: npm run dev')
    throw error
  }

  // Step 2: Verify login page loads correctly
  console.log('Step 2: Verifying login page loads...')

  try {
    await page.goto('/login')
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible({
      timeout: 10000,
    })
    console.log('  ✓ Login page loads correctly')
  } catch (error) {
    console.error('  ✗ Login page failed to load:', error)
    throw error
  }

  // Step 3: Sign in once, here, for the whole run.
  //
  // This is the only login in the suite. Every other test inherits the state
  // saved below through the `chromium` project's `storageState`, which is what
  // lets the suite run more than one worker: the old fixture logged in
  // per-test and raced N workers over one state file.
  console.log('Step 3: Signing in and saving browser state...')

  const usernameInput = page.getByRole('textbox', { name: 'Username' })
  const passwordInput = page.getByRole('textbox', { name: 'Password' })

  await usernameInput.click()
  await usernameInput.pressSequentially(E2E_TEST_CONFIG.adminUser.username, {
    delay: 30,
  })
  await passwordInput.click()
  await passwordInput.pressSequentially(E2E_TEST_CONFIG.adminUser.password, {
    delay: 30,
  })
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()

  // The login page animates for 800ms before redirecting.
  await page.waitForURL('/', { timeout: 30000, waitUntil: 'domcontentloaded' })
  console.log('  ✓ Signed in')

  // Suppress the product tour for every test that restores this state.
  // `storageState()` captures localStorage per visited origin, so setting it
  // on the app origin now carries it into the file — no per-context init
  // script for the specs to remember.
  await page.evaluate(() => {
    localStorage.setItem('cascadia-e2e-test', 'true')
  })

  await context.storageState({ path: AUTH_STATE_PATH })
  console.log(`  ✓ Saved authenticated state to ${AUTH_STATE_PATH}`)

  // Step 4: Guarantee the data the lifecycle specs hard-require.
  //
  // The part/document/requirement lifecycle specs need at least one design
  // in the create-form selector. They used to test.skip() when none existed,
  // which let a seeding regression turn the whole lifecycle suite green by
  // vacancy — so the precondition is now created here (idempotently) and the
  // specs assert it instead of skipping.
  //
  // `page.request` shares the context's cookie jar, so these calls carry the
  // session established above.
  console.log('Step 4: Ensuring a selectable design exists...')

  const designsRes = await page.request.get('/api/v1/designs')
  expect(
    designsRes.ok(),
    'listing designs must succeed — did db:seed run?',
  ).toBe(true)
  const designs: Array<{ designType?: string }> =
    (await designsRes.json()).data?.designs ?? []
  const selectable = designs.filter((d) => d.designType !== 'Library')

  if (selectable.length === 0) {
    console.log('  No non-library design found — creating E2E program+design')

    const programsRes = await page.request.get('/api/v1/programs')
    const programs: Array<{ id: string; code: string }> =
      (await programsRes.json()).data?.programs ?? []
    let program = programs.find((p) => p.code === 'E2E')

    if (!program) {
      const created = await page.request.post('/api/v1/programs', {
        data: { name: 'E2E Program', code: 'E2E' },
      })
      expect(created.ok(), 'failed to create the E2E program').toBe(true)
      const body = await created.json()
      program = body.data?.program ?? body.data
    }

    const createdDesign = await page.request.post('/api/v1/designs', {
      data: {
        name: 'E2E Design',
        code: 'E2E-DSN',
        programId: program!.id,
      },
    })
    expect(createdDesign.ok(), 'failed to create the E2E design').toBe(true)
    console.log('  ✓ Created E2E Design')
  } else {
    console.log(`  ✓ ${selectable.length} selectable design(s) present`)
  }

  console.log('')
  console.log('═'.repeat(60))
  console.log('  E2E GLOBAL SETUP COMPLETE')
  console.log('═'.repeat(60))
  console.log('')
})
