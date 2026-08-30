// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Per-file setup for the `node` project — every .test.ts file.
 *
 * Nothing DOM-flavoured belongs here: these files run without jsdom (that is
 * the point of the split), so `window`, `document`, and Element do not exist.
 * The component tests' setup lives in setup.dom.ts, which imports this file
 * for the shared mock hygiene.
 */

import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'

// Mock console.error wrap (kept from the original shared setup; the option to
// fail on React act() warnings lives in setup.dom.ts territory but the wrap
// itself is environment-neutral).
const originalConsoleError = console.error
beforeAll(() => {
  console.error = (...args: Array<unknown>) => {
    originalConsoleError.call(console, ...args)
  }
})

afterAll(() => {
  console.error = originalConsoleError
})

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})
