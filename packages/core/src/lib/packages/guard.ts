// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { PackageRegistry } from './registry'
import { packageDescriptor } from './catalog'
import type { PackageId } from './types'
import { PackageNotLicensedError } from '@/lib/errors'

/**
 * Throw unless this instance is licensed for `id`.
 *
 * Use at the entry point of any route or service that only exists because of an
 * optional package, so an unlicensed instance gets a clear 403 instead of a
 * half-working feature.
 */
export function requirePackage(id: PackageId): void {
  if (!PackageRegistry.isEnabled(id)) {
    // Falls back to the id when the package is not in this build's catalog at
    // all — the message is for a human reading a 403, and "not enabled" is the
    // honest answer either way.
    throw new PackageNotLicensedError(packageDescriptor(id)?.name ?? id, id)
  }
}
