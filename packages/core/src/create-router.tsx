// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createRouter } from '@tanstack/react-router'
import { queryClient } from './lib/query/client'
import type { AnyRoute } from '@tanstack/react-router'

/**
 * Build the app router around an edition's generated route tree.
 *
 * The tree itself cannot live here: it is generated per app, because which
 * route directories get scanned is exactly what differs between the community
 * and enterprise editions. Everything *around* the tree is identical, so it
 * lives here and each app passes its own tree in.
 *
 * `routeTree` is deliberately loose. Core cannot name the generated type — it
 * is produced from directories core does not know about — and the module
 * augmentation that makes `Link` and `useParams` type-safe is registered by the
 * app against its own tree regardless of what this signature says.
 */
export function createAppRouter(routeTree: AnyRoute) {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    // Route loaders read through the QueryClient, so React Query's own
    // staleTime decides whether a preload actually hits the network. Leaving
    // this at 0 hands that decision entirely to the query layer instead of
    // letting the router keep a second, competing freshness window.
    defaultPreloadStaleTime: 0,
    // Loaders resolve against the same cache the components read, so this is
    // the one instance both layers share.
    context: { queryClient },
  })
}
