/**
 * Test Setup File
 *
 * This file runs before each test file.
 * Use for setup that should run before every test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/dom'
import '@testing-library/jest-dom/vitest'

// Automatically cleanup after each test when using React Testing Library
afterEach(() => {
  cleanup()
})

// Mock console.error to fail tests on React warnings (optional, can be disabled)
const originalConsoleError = console.error
beforeAll(() => {
  console.error = (...args: Array<unknown>) => {
    // Optionally fail on React act() warnings
    // if (args[0]?.toString().includes('act(...)')) {
    //   throw new Error(args[0] as string)
    // }
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

// Mock window.matchMedia for components that use media queries
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: MockIntersectionObserver,
})

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
})

// Mock scrollTo
Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: vi.fn(),
})

// Polyfill for Pointer Events API (needed for Radix UI components in JSDOM)
// JSDOM doesn't implement hasPointerCapture, setPointerCapture, releasePointerCapture
// These checks are necessary at runtime even though TypeScript types claim they exist
/* eslint-disable @typescript-eslint/no-unnecessary-condition */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = vi.fn()
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = vi.fn()
}

// Polyfill for scrollIntoView (needed for Radix UI Select in JSDOM)
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn()
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

// Extend expect with custom matchers (add more as needed)
// Example: expect.extend({ toBeValidItem: ... })
