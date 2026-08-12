// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

// Export all schema definitions
export * from './users'
export * from './programs'
export * from './designs'
export * from './versioning'
export * from './items'
export * from './software'
export * from './work-orders'
export * from './workflows'
export * from './vault'
export * from './settings'
export * from './manufacturer-parts'
export * from './reports'
export * from './errors'
export * from './config'
export * from './jobs'
export * from './numbering'
export * from './ai'
export * from './thread'
export * from './cache'
export * from './crossReferences'
export * from './componentCatalog'
export * from './api-keys'

// Module-owned schema files are deliberately absent. They are composed into an
// edition by `src/modules.schema.ts`, which is what drizzle-kit reads; code
// that needs a module's tables imports them from the module's own schema file.
