// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

export {
  registerPackage,
  packageDescriptor,
  allPackageIds,
  isPackageId,
} from './catalog'
export { PackageRegistry } from './registry'
export { requirePackage } from './guard'
export type { PackageDescriptor, PackageId, PackageStatus } from './types'
