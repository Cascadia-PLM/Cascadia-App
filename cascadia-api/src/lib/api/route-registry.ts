// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { Hono } from 'hono'

/**
 * Places a module may mount API routes.
 *
 * **Core owns this list**, the same way it owns the UI slot names: where the
 * API can be extended is a design decision, not something a module invents.
 * Naming the mount points rather than accepting arbitrary paths also keeps a
 * module from quietly claiming a URL core meant to keep.
 *
 * - `api-root` mounts on the root app, for a module that owns a whole resource.
 *   Its `path` is therefore absolute (`/api/v1/signatures`), unlike the others.
 * - `admin` mounts under `/api/v1/admin`, for settings a module adds to the
 *   admin surface. Contributing here rather than taking a top-level path is
 *   what lets a module's endpoints keep the URL they already have.
 * - `parts` mounts under `/api/v1/parts`, for actions a module adds to a part.
 *   Contributions here declare their own full sub-path including `:id`, so
 *   nothing depends on path params propagating across a nested mount.
 * - `files` mounts under `/api/v1/files`, same convention as `parts`.
 */
export type RouteMountPoint = 'api-root' | 'admin' | 'parts' | 'files'

export interface RouteContribution {
  /** Path relative to the mount point, e.g. `/cad-settings`. */
  path: string
  app: Hono
}

const registry = new Map<RouteMountPoint, Array<RouteContribution>>()

/**
 * Contribute a sub-router. Called from a composition root at boot.
 *
 * Additive by contract, like `registerSlot` and unlike the name-keyed
 * registries that throw on a duplicate: a mount point holds a list of
 * sub-routers, and two modules mounting different paths under `admin` is the
 * normal case. Two contributions claiming the *same* path is a Hono routing
 * question rather than a registry one — first match wins there, as it does for
 * any two overlapping routes in a single app.
 */
export function registerRoutes(
  mount: RouteMountPoint,
  path: string,
  app: Hono,
): void {
  const existing = registry.get(mount)
  if (existing) {
    existing.push({ path, app })
  } else {
    registry.set(mount, [{ path, app }])
  }
}

/**
 * Contributions for a mount point, in registration order.
 *
 * Read once at module load by the router that owns the mount point, so
 * registration has to happen before the server's routes are built — which is
 * what the composition root's position in the entry point guarantees.
 */
export function routesFor(mount: RouteMountPoint): Array<RouteContribution> {
  return registry.get(mount) ?? []
}

/** Mount every contribution for `mount` onto `app`. */
export function mountRoutes(app: Hono, mount: RouteMountPoint): void {
  for (const contribution of routesFor(mount)) {
    app.route(contribution.path, contribution.app)
  }
}

/** Drop every contribution. Tests only. */
export function clearRoutes(): void {
  registry.clear()
}
