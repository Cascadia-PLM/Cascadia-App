// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { PackageDescriptor, PackageId } from './types'

/**
 * Every optional package this build knows about.
 *
 * Was a hardcoded object literal, which meant core described a product it does
 * not contain — the name, the feature list, the sales copy for a package that
 * only exists when its module is present. A module now supplies its own
 * descriptor; core supplies the shelf to put it on.
 *
 * Registering a package makes it listable in the admin UI and addressable by
 * `CASCADIA_PACKAGES`. It does not enable it: entitlement remains the
 * environment's answer alone, which is the whole reason it is read at deploy
 * time. A core-only build has an empty catalog and grants nothing — the correct
 * behaviour, not a degraded one.
 */
const catalog = new Map<PackageId, PackageDescriptor>()

/** Add a package to the catalog. Called from a composition root at boot. */
export function registerPackage(descriptor: PackageDescriptor): void {
  if (catalog.has(descriptor.id)) {
    throw new Error(`Package "${descriptor.id}" is already registered`)
  }
  catalog.set(descriptor.id, descriptor)
}

/** The descriptor for a package, or undefined if this build has no such package. */
export function packageDescriptor(
  id: PackageId,
): PackageDescriptor | undefined {
  return catalog.get(id)
}

/** Every registered package id, in registration order. */
export function allPackageIds(): Array<PackageId> {
  return [...catalog.keys()]
}

/** True when `value` names a package this build actually ships. */
export function isPackageId(value: string): value is PackageId {
  return catalog.has(value)
}

/** Empty the catalog. Tests only. */
export function clearPackages(): void {
  catalog.clear()
}
