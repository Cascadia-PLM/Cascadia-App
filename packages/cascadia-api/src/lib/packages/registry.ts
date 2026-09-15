// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { allPackageIds, isPackageId, packageDescriptor } from './catalog'
import type { PackageId, PackageStatus } from './types'
import { logger } from '@/lib/logging/logger'

/**
 * Resolves which optional packages this instance is entitled to run.
 *
 * The source of truth is the `CASCADIA_PACKAGES` environment variable — a
 * comma-separated list of package ids, or `*` for every package. It is read at
 * deploy time and cached; an instance administrator cannot turn a package on
 * from inside the application.
 *
 * @example
 *   CASCADIA_PACKAGES=advanced-auditing
 *   CASCADIA_PACKAGES=*
 */
export class PackageRegistry {
  private static cache: Set<PackageId> | null = null

  /** Parse `CASCADIA_PACKAGES`, warning once about ids we don't recognize. */
  private static resolve(): Set<PackageId> {
    if (this.cache) return this.cache

    const raw = process.env.CASCADIA_PACKAGES?.trim() ?? ''
    const enabled = new Set<PackageId>()

    if (raw === '*') {
      for (const id of allPackageIds()) enabled.add(id)
    } else if (raw) {
      const unknown: Array<string> = []
      for (const entry of raw.split(',')) {
        const id = entry.trim().toLowerCase()
        if (!id) continue
        if (isPackageId(id)) {
          enabled.add(id)
        } else {
          unknown.push(id)
        }
      }
      if (unknown.length > 0) {
        logger.warn(
          { unknown, known: allPackageIds() },
          'CASCADIA_PACKAGES lists unknown package ids; ignoring them',
        )
      }
    }

    this.cache = enabled
    return enabled
  }

  /** True when this instance is licensed for the given package. */
  static isEnabled(id: PackageId): boolean {
    return this.resolve().has(id)
  }

  /** The enabled package ids, in catalog order. */
  static enabled(): Array<PackageId> {
    const set = this.resolve()
    return allPackageIds().filter((id) => set.has(id))
  }

  /** Every known package with its enabled state — the admin/client listing. */
  static list(): Array<PackageStatus> {
    const set = this.resolve()
    return allPackageIds().map((id) => ({
      ...packageDescriptor(id)!,
      enabled: set.has(id),
    }))
  }

  /**
   * Drop the cached resolution so the next read re-parses the environment.
   * Only useful in tests, which mutate `process.env` between cases.
   */
  static reset(): void {
    this.cache = null
  }
}
