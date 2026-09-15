// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMatches } from '@tanstack/react-router'
import type { RegisteredRouter, RouteIds } from '@tanstack/react-router'
import type { BreadcrumbRouteInfo } from './breadcrumb-types'

type RouteId = RouteIds<RegisteredRouter['routeTree']>

const ITEM_LIST_ROUTES: ReadonlyArray<RouteId> = [
  '/parts/',
  '/documents/',
  '/requirements/',
  '/tasks/',
  '/issues/',
]

const ITEM_DETAIL_ROUTES: ReadonlyArray<RouteId> = [
  '/parts/$id',
  '/documents/$id',
  '/requirements/$id',
  '/tasks/$id',
  '/issues/$id',
]

/** A route's `$id` param, when it declares one. */
function idParam(params: object | undefined): string | undefined {
  return params && 'id' in params && typeof params.id === 'string'
    ? params.id
    : undefined
}

/**
 * Hook to detect the current route type for breadcrumb rendering.
 * Returns flags for different page types (list pages, detail pages, etc.)
 *
 * Everything is read from one place: the deepest route match the router has
 * committed. The flags used to test `useLocation()`'s pathname against
 * `useParams()`'s id, and those disagree for the length of every navigation —
 * the router moves the location to the destination as soon as a navigation
 * starts, but swaps the matches, and the params with them, only once the
 * destination has loaded. Leaving a design page for /change-orders/new
 * therefore rendered for a moment as a change order detail page (the
 * destination's pathname, the design's id), and the breadcrumbs asked the API
 * for item "new". Classifying by route id rather than by pathname pattern also
 * keeps a static segment like `new` from ever being read as an id.
 */
export function useBreadcrumbRouteInfo(): BreadcrumbRouteInfo {
  const leaf = useMatches({ select: (matches) => matches.at(-1) })

  const routeId = leaf?.routeId
  const pathname = leaf?.pathname ?? '/'

  // Detect route type
  const isItemListPage = ITEM_LIST_ROUTES.some((id) => id === routeId)
  const isItemDetailPage = ITEM_DETAIL_ROUTES.some((id) => id === routeId)
  const isDesignDetailPage = routeId === '/designs/$id'
  const isProgramDetailPage = routeId === '/programs/$id'
  const isChangeOrderDetailPage = routeId === '/change-orders/$id'
  const isChangeOrderListPage = routeId === '/change-orders/'
  const isDesignListPage = routeId === '/designs/'
  const isProgramListPage = routeId === '/programs/'

  // Derived flags
  const isListPageWithDropdowns =
    isItemListPage || isChangeOrderListPage || isDesignListPage
  const needsDesignDropdown = isItemListPage || isChangeOrderListPage
  const isDetailPage =
    isItemDetailPage ||
    isDesignDetailPage ||
    isProgramDetailPage ||
    isChangeOrderDetailPage

  return {
    pathname,
    detailId: isDetailPage ? idParam(leaf?.params) : undefined,
    isItemListPage,
    isItemDetailPage,
    isDesignDetailPage,
    isProgramDetailPage,
    isChangeOrderDetailPage,
    isChangeOrderListPage,
    isDesignListPage,
    isProgramListPage,
    isListPageWithDropdowns,
    needsDesignDropdown,
  }
}
