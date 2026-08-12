// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Package entitlement is a licensing boundary: it decides whether paid
 * functionality is reachable at all. The invariant under test is that nothing
 * except an explicit `CASCADIA_PACKAGES` grant can turn a package on.
 *
 * Registers a fictional package rather than naming a real one. The registry is
 * core; the packages are not. A core test asserting on a shipped package id
 * would fail in a build that does not ship it — which is precisely the build
 * this whole effort exists to make possible.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PackageRegistry } from './registry'
import { requirePackage } from './guard'
import { clearPackages, registerPackage } from './catalog'
import { ErrorCode } from '@/lib/errors/codes'
import { AppError } from '@/lib/errors'

/** A package that exists only here, so core never asserts on a shipped one. */
const TEST_PACKAGE = 'test-package'

function registerTestPackage() {
  clearPackages()
  registerPackage({
    id: TEST_PACKAGE,
    name: 'Test Package',
    description: 'Exists only for this suite.',
    features: ['A feature'],
  })
  PackageRegistry.reset()
}

describe('PackageRegistry', () => {
  const original = process.env.CASCADIA_PACKAGES

  beforeEach(() => {
    registerTestPackage()
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CASCADIA_PACKAGES
    } else {
      process.env.CASCADIA_PACKAGES = original
    }
    PackageRegistry.reset()
    clearPackages()
  })

  function setEnv(value: string | undefined) {
    if (value === undefined) {
      delete process.env.CASCADIA_PACKAGES
    } else {
      process.env.CASCADIA_PACKAGES = value
    }
    PackageRegistry.reset()
  }

  describe('default-off behavior', () => {
    it('enables nothing when the variable is unset', () => {
      setEnv(undefined)
      expect(PackageRegistry.isEnabled(TEST_PACKAGE)).toBe(false)
      expect(PackageRegistry.enabled()).toEqual([])
    })

    it('enables nothing when the variable is empty or whitespace', () => {
      for (const value of ['', '   ', ',', ' , , ']) {
        setEnv(value)
        expect(PackageRegistry.isEnabled(TEST_PACKAGE)).toBe(false)
      }
    })

    it('ignores unknown package ids without enabling anything', () => {
      setEnv('not-a-real-package,another-fake')
      expect(PackageRegistry.enabled()).toEqual([])
    })

    it('does not enable a package named only as a substring', () => {
      setEnv(`${TEST_PACKAGE}-plus`)
      expect(PackageRegistry.isEnabled(TEST_PACKAGE)).toBe(false)
    })
  })

  describe('explicit grants', () => {
    it('enables a package named exactly', () => {
      setEnv(TEST_PACKAGE)
      expect(PackageRegistry.isEnabled(TEST_PACKAGE)).toBe(true)
    })

    it('tolerates surrounding whitespace and casing', () => {
      setEnv(`  ${TEST_PACKAGE.toUpperCase()}  `)
      expect(PackageRegistry.isEnabled(TEST_PACKAGE)).toBe(true)
    })

    it('enables every package for the wildcard', () => {
      setEnv('*')
      expect(PackageRegistry.isEnabled(TEST_PACKAGE)).toBe(true)
    })

    it('keeps known ids when the list also contains unknown ones', () => {
      setEnv(`bogus,${TEST_PACKAGE}`)
      expect(PackageRegistry.isEnabled(TEST_PACKAGE)).toBe(true)
    })
  })

  describe('list()', () => {
    it('reports every catalog package with its state', () => {
      setEnv(undefined)
      const listed = PackageRegistry.list()

      expect(listed.length).toBeGreaterThan(0)
      const entry = listed.find((p) => p.id === TEST_PACKAGE)
      expect(entry).toBeDefined()
      expect(entry?.enabled).toBe(false)
      expect(entry?.features.length).toBeGreaterThan(0)
    })
  })
})

describe('requirePackage', () => {
  const original = process.env.CASCADIA_PACKAGES

  beforeEach(() => {
    registerTestPackage()
  })

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CASCADIA_PACKAGES
    } else {
      process.env.CASCADIA_PACKAGES = original
    }
    PackageRegistry.reset()
    clearPackages()
  })

  it('throws PACKAGE_NOT_LICENSED when the package is off', () => {
    delete process.env.CASCADIA_PACKAGES
    PackageRegistry.reset()

    try {
      requirePackage(TEST_PACKAGE)
      expect.unreachable('requirePackage should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe(ErrorCode.PACKAGE_NOT_LICENSED)
    }
  })

  it('returns silently when the package is on', () => {
    process.env.CASCADIA_PACKAGES = TEST_PACKAGE
    PackageRegistry.reset()

    expect(() => requirePackage(TEST_PACKAGE)).not.toThrow()
  })
})
