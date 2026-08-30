// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Stylesheet E2E Smoke Test
 *
 * Needs no login — the sign-in page is enough.
 *
 * This exists because the whole application once rendered as unstyled HTML in
 * both editions and every gate stayed green, including these E2E tests. Tailwind
 * v4 detects sources automatically, rooted at the Vite root; the Phase 2 split
 * moved that root to `apps/<app>/` while every component stayed in `packages/`,
 * so it found no class names and emitted preflight alone — resets and theme
 * variables, not one `.bg-*` rule.
 *
 * Nothing failed. Routing worked, auth worked, the API answered, the container
 * healthcheck passed, and 65 E2E tests passed, because the suite waits on
 * `/api/v1/health` and then asserts on text and roles. Every element it looks
 * for was present and correctly labelled. It was simply invisible as a product.
 *
 * So this asserts the one thing the rest of the suite never does: that styles
 * were actually applied. It reads computed values rather than class attributes
 * — `class="bg-primary"` is present either way, and was, throughout. The
 * assertions target properties no browser default supplies, so they fail when
 * the stylesheet is empty and pass regardless of what the palette becomes.
 */

import { expect, test } from '@playwright/test'

const TRANSPARENT = new Set(['rgba(0, 0, 0, 0)', 'transparent'])

/*
 * The sign-in page is the subject here, so this opts out of the signed-in
 * state the setup project saves — authenticated, `/` renders the dashboard.
 */
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('Stylesheet', () => {
  test('the sign-in page renders with its stylesheet applied', async ({
    page,
  }) => {
    await page.goto('/')
    await page.waitForSelector('[data-testid="login-form"]', {
      state: 'visible',
    })

    const submit = page.getByRole('button', { name: 'Sign in', exact: true })

    // A styled button. `inline-flex` and a non-transparent fill are Tailwind's
    // doing — the browser default is `inline-block` and transparent.
    const button = await submit.evaluate((el) => {
      const cs = getComputedStyle(el)
      return {
        display: cs.display,
        background: cs.backgroundColor,
        radius: cs.borderRadius,
      }
    })

    expect(
      TRANSPARENT.has(button.background),
      'the submit button has no background colour — Tailwind emitted no utilities, so the app is rendering unstyled',
    ).toBe(false)
    expect(button.display).toBe('inline-flex')
    expect(button.radius).not.toBe('0px')

    // And a styled input: browsers supply no border radius of their own here.
    const input = await page
      .getByRole('textbox', { name: 'Username' })
      .evaluate((el) => getComputedStyle(el).borderRadius)
    expect(input).not.toBe('0px')
  })

  test('the document stylesheet contains utility rules, not just preflight', async ({
    page,
  }) => {
    await page.goto('/')
    await page.waitForSelector('[data-testid="login-form"]', {
      state: 'visible',
    })

    // Counted by walking into `@layer` blocks: Tailwind v4 nests utilities
    // inside them, so a flat pass over `cssRules` reports zero either way.
    const utilities = await page.evaluate(() => {
      let count = 0
      const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          // Partial, not CSSGroupingRule: only grouping rules have `cssRules`,
          // and asserting the non-optional type makes the guard below read as
          // always-true to the type system while being load-bearing at runtime.
          const nested = (rule as Partial<CSSGroupingRule>).cssRules
          if (nested) walk(nested)
          const selector = (rule as CSSStyleRule).selectorText
          if (
            selector &&
            /^\.(?:bg|text|flex|grid|p|m|rounded)-/.test(selector)
          )
            count++
        }
      }
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          walk(sheet.cssRules)
        } catch {
          // Cross-origin sheet; nothing to read.
        }
      }
      return count
    })

    expect(
      utilities,
      'the page loaded a stylesheet with (almost) no utility classes — check the `@source` directives in packages/core/src/styles.css',
    ).toBeGreaterThan(50)
  })
})
