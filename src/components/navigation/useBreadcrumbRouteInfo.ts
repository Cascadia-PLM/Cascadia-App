import { useLocation, useParams } from '@tanstack/react-router'
import type { BreadcrumbRouteInfo } from './breadcrumb-types'

/**
 * Hook to detect the current route type for breadcrumb rendering.
 * Returns flags for different page types (list pages, detail pages, etc.)
 */
export function useBreadcrumbRouteInfo(): BreadcrumbRouteInfo {
  const location = useLocation()
  const params = useParams({ strict: false })
  const pathname = location.pathname

  // Detect route type
  const isItemListPage =
    /^\/(parts|documents|requirements|tasks|issues)\/?$/.test(pathname)
  const isItemDetailPage =
    /^\/(parts|documents|requirements|tasks|issues)\/[^/]+$/.test(pathname) &&
    !!params.id
  const isDesignDetailPage =
    /^\/designs\/[^/]+/.test(pathname) &&
    !!params.id &&
    !pathname.includes('/edit') &&
    !pathname.startsWith('/designs/collaborative') &&
    !pathname.startsWith('/designs/workspaces')
  const isProgramDetailPage = /^\/programs\/[^/]+/.test(pathname) && !!params.id
  const isChangeOrderDetailPage =
    /^\/change-orders\/[^/]+/.test(pathname) && !!params.id
  const isChangeOrderListPage =
    pathname === '/change-orders' || pathname === '/change-orders/'
  const isDesignListPage = pathname === '/designs' || pathname === '/designs/'
  const isProgramListPage =
    pathname === '/programs' || pathname === '/programs/'

  // Derived flags
  const isListPageWithDropdowns =
    isItemListPage || isChangeOrderListPage || isDesignListPage
  const needsDesignDropdown = isItemListPage || isChangeOrderListPage

  return {
    pathname,
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
