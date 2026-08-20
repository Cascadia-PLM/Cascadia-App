// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { qk } from './keys'
import type { QueryClient } from '@tanstack/react-query'
import type { Resource } from './keys'

/**
 * Which *other* resources go stale when a resource is mutated.
 *
 * Cascadia surfaces the same row through several endpoints — a Part is
 * readable via `/parts`, via `/items`, and inside `/dashboard` rollups — so
 * invalidating only the endpoint you just POSTed to leaves the other two
 * views showing the pre-mutation answer. This map encodes those overlaps in
 * one place instead of leaving each call site to remember them.
 *
 * Edges are followed transitively (see `expandResources`), so an entry only
 * needs to list its *direct* dependents.
 */
const RESOURCE_DEPENDENTS: Partial<Record<Resource, ReadonlyArray<Resource>>> =
  {
    // ---- Item-typed resources -------------------------------------------
    // Every one of these is also a row in `items`, and feeds the cross-item
    // aggregates. `items` fans out to the aggregates on its own, so these
    // only need to name `items`.
    parts: ['items', 'relationships', 'mbom'],
    documents: ['items'],
    requirements: ['items', 'relationships'],
    tasks: ['items'],
    issues: ['items'],
    tools: ['items'],
    software: ['items'],
    // A test case's pass/fail rollup is rendered by its parent plan, so a run
    // recorded here restages the plan's view as well.
    'test-cases': ['items', 'requirements', 'test-plans'],
    'test-plans': ['items'],
    'work-instructions': ['items'],
    'work-orders': ['items', 'physical-parts'],
    'physical-parts': ['items', 'work-orders'],

    // A change order owns a branch; releasing one rewrites revisions across
    // every item type, so it invalidates the whole versioning surface.
    'change-orders': [
      'items',
      'branches',
      'branch-items',
      'commits',
      'designs',
      'workflows',
    ],

    // ---- Cross-item aggregates ------------------------------------------
    // The hub: anything item-shaped lands here, and everything that reads
    // across items hangs off it.
    items: ['dashboard', 'enterprise-search', 'thread', 'sysml'],

    // ---- Structure & organisation ---------------------------------------
    designs: ['items', 'programs', 'workspaces'],
    programs: ['designs', 'dashboard'],
    relationships: ['items', 'parts', 'designs', 'mbom'],
    mbom: ['items', 'parts'],

    // ---- Versioning ------------------------------------------------------
    // Item resolution is per-branch, so moving a branch pointer changes what
    // *every* item read returns.
    branches: ['items', 'branch-items', 'commits'],
    'branch-items': ['items', 'branches'],
    commits: ['items', 'branches', 'thread'],
    workspaces: ['items', 'branches', 'designs'],
    tags: ['items', 'commits'],

    // ---- Workflow & lifecycle -------------------------------------------
    workflows: ['items', 'change-orders', 'dashboard'],
    lifecycles: ['items', 'workflows'],

    // ---- Sourcing --------------------------------------------------------
    'manufacturer-parts': ['parts', 'items'],

    // ---- Files -----------------------------------------------------------
    files: ['items', 'thread'],

    // ---- Admin & access --------------------------------------------------
    // Both reach 'auth': the signed-in user's cached permission map (which
    // decides whether the System section is offered at all) is derived from
    // their role assignments, so changing either has to restage it.
    users: ['admin', 'roles', 'programs', 'designs', 'auth'],
    roles: ['admin', 'users', 'auth'],
    admin: ['items', 'lifecycles', 'workflows'],
    setup: ['auth', 'programs', 'users', 'tools'],
    auth: ['setup'],

    // ---- Async work ------------------------------------------------------
    // A finished job usually wrote something item-shaped (CAD conversion,
    // import), so surfacing job state refreshes items too.
    jobs: ['items', 'files'],
    import: ['items', 'parts', 'designs', 'jobs'],
  }

/** Edges contributed by modules, merged over the core map at lookup time. */
const contributed = new Map<Resource, Array<Resource>>()

/**
 * Declare that mutating each key also staleness-marks its listed resources.
 *
 * Additive in both directions, which is the point: a module both introduces its
 * own resources *and* adds edges to core's. Advanced Auditing needs
 * `signatures → workflows` because a signature changes what an approval panel
 * shows, and equally `workflows → signatures`, because core has no reason to
 * know that approving something produces a signature.
 *
 * Call from a composition root at boot, before the first invalidation.
 */
export function registerResourceDependents(
  entries: Partial<Record<Resource, ReadonlyArray<Resource>>>,
): void {
  // `Object.entries` widens a Partial's values to the non-optional type, which
  // would make the guard below look dead. It is not: an explicit `undefined`
  // value is legal in the argument type.
  const pairs = Object.entries(entries) as Array<
    [Resource, ReadonlyArray<Resource> | undefined]
  >

  for (const [resource, dependents] of pairs) {
    if (!dependents) continue
    const existing = contributed.get(resource)
    if (existing) existing.push(...dependents)
    else contributed.set(resource, [...dependents])
  }
}

/** Drop contributed edges. Tests only. */
export function clearResourceDependents(): void {
  contributed.clear()
}

/** Core's edges for a resource plus anything a module added for it. */
function dependentsOf(resource: Resource): ReadonlyArray<Resource> {
  const base = RESOURCE_DEPENDENTS[resource] ?? []
  const extra = contributed.get(resource)
  return extra ? [...base, ...extra] : base
}

/**
 * Expand a set of mutated resources into everything that must be refetched,
 * following the dependency edges transitively.
 *
 * Cycles are expected (`parts → items → … → parts`) and terminate on the
 * visited set.
 */
export function expandResources(
  resources: ReadonlyArray<Resource>,
): Array<Resource> {
  const seen = new Set<Resource>()
  const queue = [...resources]

  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined || seen.has(next)) continue
    seen.add(next)
    queue.push(...dependentsOf(next))
  }

  return [...seen]
}

/**
 * Invalidate every query belonging to the given resources and their
 * dependents.
 *
 * Returns once the invalidation is registered. Mounted queries refetch
 * immediately; unmounted ones are marked stale and refetch when their
 * component or loader next runs — which is what makes a mutation on one page
 * show up on a page that is not currently rendered.
 */
export async function invalidateResources(
  queryClient: QueryClient,
  resources: ReadonlyArray<Resource>,
): Promise<void> {
  const targets = expandResources(resources)
  await Promise.all(
    targets.map((resource) =>
      queryClient.invalidateQueries({ queryKey: qk.all(resource) }),
    ),
  )
}

/**
 * Drop every cached read. Reserved for identity changes — login, logout,
 * impersonation — where the previous user's data must not survive.
 *
 * This clears rather than invalidates. `invalidateQueries` only marks entries
 * stale and leaves `state.data` in place, and the root route reads the session
 * through `ensureQueryData`, which returns cached data whether or not it is
 * stale (it fetches only when there is no entry at all). After a login that
 * left the signed-out `{ authenticated: false }` entry behind, `beforeLoad`
 * would read it straight back and redirect to /login — the sign-in button
 * looping on itself. Removing the entries is what forces a real refetch.
 */
export function invalidateEverything(queryClient: QueryClient): void {
  queryClient.clear()
}
