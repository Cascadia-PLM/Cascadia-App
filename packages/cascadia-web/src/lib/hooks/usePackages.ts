// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import type { PackageId, PackageStatus } from '@/lib/packages/types'
import { packageListQuery } from '@/lib/query'

/**
 * Which optional packages this instance is licensed for.
 *
 * Read through the shared query cache, so one fetch serves every caller
 * whether or not they are mounted together. This drives *presentation only* —
 * every gated route re-checks the entitlement server-side, so a tampered
 * client gains nothing.
 */
export function usePackages(): {
  packages: Array<PackageStatus>
  loading: boolean
} {
  const { data, isPending } = useQuery(packageListQuery())
  return { packages: data ?? [], loading: isPending }
}

/** True when `id` is licensed. `loading` distinguishes "no" from "not yet known". */
export function usePackageEnabled(id: PackageId): {
  enabled: boolean
  loading: boolean
} {
  const { packages, loading } = usePackages()
  return {
    enabled: packages.some((pkg) => pkg.id === id && pkg.enabled),
    loading,
  }
}
