import { useNavigate, useSearch } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useBreadcrumbRouteInfo } from './useBreadcrumbRouteInfo'
import { useBreadcrumbData } from './useBreadcrumbData'
import { BreadcrumbDropdown } from './BreadcrumbDropdown'
import { BreadcrumbLink } from './BreadcrumbLink'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { VersionContextSelector } from '@/components/versioning/VersionContextSelector'

/**
 * Breadcrumbs - Hierarchical navigation showing Program > Design > Item
 *
 * On list pages, shows dropdowns for Program and Design selection.
 * On detail pages, shows clickable links to parent entities.
 */
export function Breadcrumbs() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false })

  // Get route info and breadcrumb data using extracted hooks
  const routeInfo = useBreadcrumbRouteInfo()
  const { programs, designs, breadcrumbData } = useBreadcrumbData(routeInfo)

  const {
    pathname,
    isItemListPage,
    isItemDetailPage,
    isChangeOrderDetailPage,
    isListPageWithDropdowns,
    needsDesignDropdown,
    isProgramListPage,
  } = routeInfo

  // Get IDs from URL
  const selectedProgramId = search.programId
  const selectedDesignId = search.designId

  // Get designId for detail pages from breadcrumb data
  const detailPageDesignId =
    breadcrumbData.item?.designId || breadcrumbData.design?.id

  // Version context - use selectedDesignId for list pages, detailPageDesignId for detail pages
  const activeDesignId = isListPageWithDropdowns
    ? selectedDesignId
    : detailPageDesignId
  const { context, setContext } = useVersionContext(activeDesignId)

  // Handle program selection from dropdown
  const handleProgramSelect = (programId: string) => {
    const basePath = pathname.split('/')[1]
    navigate({
      to: `/${basePath}`,
      search: {
        programId: programId || undefined,
        // Clear design when program changes
        designId: undefined,
        branch: undefined,
        tag: undefined,
        commit: undefined,
      },
    })
  }

  // Handle design selection from dropdown
  const handleDesignSelect = (designId: string) => {
    const basePath = pathname.split('/')[1]
    navigate({
      to: `/${basePath}`,
      search: (prev) => ({
        ...prev,
        designId: designId || undefined,
        branch: undefined,
        tag: undefined,
        commit: undefined,
      }),
    })
  }

  // Handle version context change
  const handleVersionContextChange = (newContext: VersionContext) => {
    setContext(newContext)
  }

  // Filter designs by selected program
  const filteredDesigns = selectedProgramId
    ? designs.filter((d) => d.programId === selectedProgramId)
    : designs

  // Sort designs for dropdown
  const sortedDesigns = [...filteredDesigns].sort((a, b) =>
    (a.code || '').localeCompare(b.code || ''),
  )

  // Don't render on pages that don't need breadcrumbs
  if (isProgramListPage || pathname === '/' || pathname === '/login') {
    return null
  }

  // For detail pages, don't render if we have no data yet
  if (
    !isListPageWithDropdowns &&
    !breadcrumbData.program &&
    !breadcrumbData.design &&
    !breadcrumbData.item
  ) {
    return null
  }

  return (
    <nav className="flex items-center gap-1 text-sm">
      {/* List pages: Show dropdowns */}
      {isListPageWithDropdowns ? (
        <>
          {/* Program dropdown */}
          <BreadcrumbDropdown
            type="program"
            items={programs}
            selectedId={selectedProgramId}
            onSelect={handleProgramSelect}
            placeholder="All Programs"
          />

          {/* Design dropdown (not shown on /designs page) */}
          {needsDesignDropdown && (
            <>
              <ChevronRight className="h-4 w-4 text-slate-400" />
              <BreadcrumbDropdown
                type="design"
                items={sortedDesigns}
                selectedId={selectedDesignId}
                onSelect={handleDesignSelect}
                placeholder="All Designs"
              />

              {/* Version context selector - next breadcrumb after design */}
              {selectedDesignId && isItemListPage && (
                <>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                  <VersionContextSelector
                    designId={selectedDesignId}
                    value={context}
                    onChange={handleVersionContextChange}
                    variant="breadcrumb"
                  />
                </>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {/* Detail pages: Show links */}
          {/* Program segment */}
          {breadcrumbData.program && (
            <BreadcrumbLink
              to="/programs/$id"
              params={{ id: breadcrumbData.program.id }}
              label={breadcrumbData.program.code}
              showChevron={!!(breadcrumbData.design || breadcrumbData.item)}
            />
          )}

          {/* Design segment */}
          {breadcrumbData.design && (
            <BreadcrumbLink
              to="/designs/$id"
              params={{ id: breadcrumbData.design.id }}
              label={breadcrumbData.design.code}
              showChevron={!!breadcrumbData.item}
            />
          )}

          {/* Item segment (text, not link) */}
          {breadcrumbData.item && (
            <span className="font-medium text-slate-900 dark:text-white">
              {breadcrumbData.item.itemNumber}
            </span>
          )}

          {/* Version context selector for item/change-order detail pages */}
          {(isItemDetailPage || isChangeOrderDetailPage) &&
            detailPageDesignId && (
              <>
                <ChevronRight className="h-4 w-4 text-slate-400" />
                <VersionContextSelector
                  designId={detailPageDesignId}
                  value={context}
                  onChange={handleVersionContextChange}
                  variant="breadcrumb"
                  itemId={breadcrumbData.item?.id}
                />
              </>
            )}
        </>
      )}
    </nav>
  )
}
