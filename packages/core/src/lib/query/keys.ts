// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Central query-key registry.
 *
 * Every cached read in the app is keyed through this module so that a
 * mutation can invalidate by resource without knowing which component or
 * route loader happens to hold the data. Keys are hierarchical:
 *
 *   [resource]                       — everything for a resource
 *   [resource, 'list']               — every list variant
 *   [resource, 'list', params]       — one list variant
 *   [resource, 'detail', id]         — one entity
 *   [resource, 'detail', id, sub]    — a sub-collection of one entity
 *
 * Because TanStack Query matches `invalidateQueries` by key *prefix*,
 * invalidating `['parts']` reaches every list variant and every detail
 * page for parts, mounted or not.
 */

/** Every API resource under `/api/v1/`. Mirrors the mounts in `src/server/index.ts`. */
export const RESOURCES = [
  'admin',
  'ai',
  'auth',
  'branch-items',
  'branches',
  'change-orders',
  'commits',
  'dashboard',
  'designs',
  'documents',
  'enterprise-search',
  'files',
  'import',
  'issues',
  'items',
  'jobs',
  'lifecycles',
  'manufacturer-parts',
  'mbom',
  'packages',
  'parts',
  'physical-parts',
  'programs',
  'relationships',
  'reports',
  'requirements',
  'roles',
  'setup',
  'software',
  'sysml',
  'tags',
  'tasks',
  'test-cases',
  'test-plans',
  'thread',
  'tools',
  'users',
  'work-instructions',
  'work-orders',
  'workflows',
  'workspaces',
] as const

/**
 * Resources contributed by an optional package.
 *
 * Empty in core; a module widens it by declaration merging, the same mechanism
 * `ApprovalExtras` uses:
 *
 * ```typescript
 * declare module '@/lib/query/keys' {
 *   interface ModuleResources {
 *     signatures: true
 *   }
 * }
 * ```
 *
 * The value type is irrelevant — only the key matters — but it has to be
 * something, so `true` reads as "this resource exists".
 */
export interface ModuleResources {}

export type Resource = (typeof RESOURCES)[number] | keyof ModuleResources

/**
 * Query-key builders.
 *
 * `params` is embedded directly; TanStack Query hashes keys structurally, so
 * two calls with equal-by-value params share a cache entry regardless of
 * object identity. Key order matters — keep param objects built by a shared
 * helper (see `grid-params.ts`) rather than assembled inline, so a loader and
 * its component produce the same key and therefore share one fetch.
 */
export const qk = {
  /** Everything cached for a resource. The invalidation workhorse. */
  all: (resource: Resource) => [resource] as const,

  /** Every list variant of a resource, across all filter/sort/page params. */
  lists: (resource: Resource) => [resource, 'list'] as const,

  /** One list variant. */
  list: (resource: Resource, params?: unknown) =>
    [resource, 'list', params ?? {}] as const,

  /** Every detail entry of a resource. */
  details: (resource: Resource) => [resource, 'detail'] as const,

  /** One entity's detail record. */
  detail: (resource: Resource, id: string) => [resource, 'detail', id] as const,

  /**
   * A sub-collection hanging off one entity — e.g. a part's AML, a work
   * order's traveler. Nested under the entity so invalidating the entity
   * also refreshes its sub-collections.
   */
  sub: (resource: Resource, id: string, sub: string, params?: unknown) =>
    params === undefined
      ? ([resource, 'detail', id, sub] as const)
      : ([resource, 'detail', id, sub, params] as const),

  /**
   * A resource-scoped collection not tied to one entity — e.g. design
   * families, part counts by state.
   */
  collection: (resource: Resource, name: string, params?: unknown) =>
    params === undefined
      ? ([resource, name] as const)
      : ([resource, name, params] as const),
} as const
