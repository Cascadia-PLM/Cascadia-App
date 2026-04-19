import { useEffect, useState } from 'react'
import type { Design } from '@/lib/types/design'
import type { Program } from '@/lib/types/program'
import type {
  BreadcrumbData,
  BreadcrumbRouteInfo,
  UseBreadcrumbDataResult,
} from './breadcrumb-types'
import { apiFetch } from '@/lib/api/client'

// Type definitions for API responses
type DesignResponse = {
  data: {
    design: {
      id: string
      name: string
      code: string
      programId?: string | null
    }
  }
}

type ProgramResponse = {
  data: { program: { id: string; name: string; code: string } }
}

type ItemResponse = {
  data: {
    item: {
      id: string
      itemNumber: string
      itemType: string
      designId?: string
    }
  }
}

/**
 * Extract ID from pathname for a given route pattern.
 * More reliable than params.id which can be stale during navigation.
 */
function extractIdFromPath(pathname: string, pattern: RegExp): string | null {
  const match = pathname.match(pattern)
  return match ? match[1] : null
}

/**
 * Hook to fetch breadcrumb data based on current route.
 * Handles both list page data (programs/designs for dropdowns) and
 * detail page data (parent program/design for links).
 */
export function useBreadcrumbData(
  routeInfo: BreadcrumbRouteInfo,
): UseBreadcrumbDataResult {
  const [breadcrumbData, setBreadcrumbData] = useState<BreadcrumbData>({})
  const [programs, setPrograms] = useState<Array<Program>>([])
  const [designs, setDesigns] = useState<Array<Design>>([])

  const {
    pathname,
    isListPageWithDropdowns,
    needsDesignDropdown,
    isProgramListPage,
    isItemDetailPage,
    isDesignDetailPage,
    isProgramDetailPage,
    isChangeOrderDetailPage,
  } = routeInfo

  // Extract IDs directly from pathname to avoid race conditions during navigation
  // where params.id might be stale while pathname has already changed
  // Note: Use non-capturing group (?:...) for route type so ID is in group 1
  const itemIdFromPath = extractIdFromPath(
    pathname,
    /^\/(?:parts|documents|requirements|tasks|issues)\/([^/]+)/,
  )
  const designIdFromPath = extractIdFromPath(pathname, /^\/designs\/([^/]+)/)
  const programIdFromPath = extractIdFromPath(pathname, /^\/programs\/([^/]+)/)
  const changeOrderIdFromPath = extractIdFromPath(
    pathname,
    /^\/change-orders\/([^/]+)/,
  )

  // Fetch programs and designs for list pages
  useEffect(() => {
    async function fetchListData() {
      if (!isListPageWithDropdowns) return

      try {
        // Fetch programs
        const programsRes = await apiFetch<{
          data: { programs: Array<Program> }
        }>('/api/programs')
        setPrograms(programsRes.data.programs)

        // Fetch designs (for pages that need design dropdown)
        if (needsDesignDropdown) {
          const designsRes = await apiFetch<{
            data: { designs: Array<Design> }
          }>('/api/designs')
          setDesigns(designsRes.data.designs)
        }
      } catch {
        // Silently fail - breadcrumb dropdowns will show empty state
      }
    }
    fetchListData()
  }, [isListPageWithDropdowns, needsDesignDropdown])

  // Fetch breadcrumb data for detail pages
  useEffect(() => {
    async function fetchBreadcrumbData() {
      // Skip for list pages (they use dropdowns instead)
      if (isListPageWithDropdowns || isProgramListPage) {
        setBreadcrumbData({})
        return
      }

      try {
        const data: BreadcrumbData = {}

        // For item detail pages, fetch the item first
        if (isItemDetailPage && itemIdFromPath) {
          try {
            const itemRes = await apiFetch<ItemResponse>(
              `/api/items/${itemIdFromPath}`,
            )
            data.item = {
              id: itemRes.data.item.id,
              itemNumber: itemRes.data.item.itemNumber,
              itemType: itemRes.data.item.itemType,
              designId: itemRes.data.item.designId,
            }

            if (itemRes.data.item.designId) {
              const designRes = await apiFetch<DesignResponse>(
                `/api/designs/${itemRes.data.item.designId}`,
              )
              data.design = designRes.data.design

              if (designRes.data.design.programId) {
                const programRes = await apiFetch<ProgramResponse>(
                  `/api/programs/${designRes.data.design.programId}`,
                )
                data.program = programRes.data.program
              }
            }
          } catch {
            // Silently fail - breadcrumb will show without item context
          }
        }

        // For change order detail pages
        if (isChangeOrderDetailPage && changeOrderIdFromPath) {
          try {
            const itemRes = await apiFetch<ItemResponse>(
              `/api/items/${changeOrderIdFromPath}`,
            )
            data.item = {
              id: itemRes.data.item.id,
              itemNumber: itemRes.data.item.itemNumber,
              itemType: itemRes.data.item.itemType,
              designId: itemRes.data.item.designId,
            }

            if (itemRes.data.item.designId) {
              const designRes = await apiFetch<DesignResponse>(
                `/api/designs/${itemRes.data.item.designId}`,
              )
              data.design = designRes.data.design

              if (designRes.data.design.programId) {
                const programRes = await apiFetch<ProgramResponse>(
                  `/api/programs/${designRes.data.design.programId}`,
                )
                data.program = programRes.data.program
              }
            }
          } catch {
            // Silently fail - breadcrumb will show without change order context
          }
        }

        // For design detail pages
        if (isDesignDetailPage && designIdFromPath) {
          try {
            const designRes = await apiFetch<DesignResponse>(
              `/api/designs/${designIdFromPath}`,
            )
            data.design = designRes.data.design

            if (designRes.data.design.programId) {
              const programRes = await apiFetch<ProgramResponse>(
                `/api/programs/${designRes.data.design.programId}`,
              )
              data.program = programRes.data.program
            }
          } catch {
            // Silently fail - breadcrumb will show without design context
          }
        }

        // For program detail pages
        if (isProgramDetailPage && programIdFromPath) {
          try {
            const programRes = await apiFetch<ProgramResponse>(
              `/api/programs/${programIdFromPath}`,
            )
            data.program = programRes.data.program
          } catch {
            // Silently fail - breadcrumb will show without program context
          }
        }

        setBreadcrumbData(data)
      } catch {
        // Silently fail - breadcrumb will show default state
      }
    }

    fetchBreadcrumbData()
  }, [
    pathname,
    isListPageWithDropdowns,
    isProgramListPage,
    isItemDetailPage,
    isDesignDetailPage,
    isProgramDetailPage,
    isChangeOrderDetailPage,
    itemIdFromPath,
    designIdFromPath,
    programIdFromPath,
    changeOrderIdFromPath,
  ])

  return {
    programs,
    designs,
    breadcrumbData,
  }
}
