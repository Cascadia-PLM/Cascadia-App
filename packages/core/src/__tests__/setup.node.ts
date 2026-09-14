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
import { ItemTypeRegistry } from '@/lib/items/registry'
// Code definitions, so a suite that never imports a route module still has
// them — the same registration every composition root performs.
import '@/lib/items/registerItemTypes.server'

// Runtime item-type configuration, awaited once per worker process.
//
// Production awaits this in each composition root (`server/index.ts`,
// `runJobsWorker`); the suite needs the same guarantee. It used to come from a
// fire-and-forget `initialize()` inside registerItemTypes.server that usually
// won its race against the test body — "usually" being the problem, and the
// reason the call moved to the callers. globalSetup seeds the rows this reads
// before the workers fork, so this is one query per fork.
beforeAll(async () => {
  await ItemTypeRegistry.initialize()
})

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
