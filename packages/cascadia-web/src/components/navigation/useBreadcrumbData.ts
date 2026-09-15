// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import type { Design } from '@/lib/types/design'
import type { Program } from '@/lib/types/program'
import type {
  BreadcrumbData,
  BreadcrumbRouteInfo,
  UseBreadcrumbDataResult,
} from './breadcrumb-types'
import { entityQuery } from '@/lib/query'
import { designListQuery } from '@/lib/query/options/designs'
import { programListQuery } from '@/lib/query/options/programs'

type BreadcrumbItem = NonNullable<BreadcrumbData['item']>

/**
 * Hook to fetch breadcrumb data based on current route.
 * Handles both list page data (programs/designs for dropdowns) and
 * detail page data (parent program/design for links).
 *
 * A detail page's trail is resolved one hop at a time — the item names its
 * design, the design its program — and each hop is a query keyed by the id it
 * reads. A response that arrives after the user has moved on lands in its own
 * cache entry rather than in the next page's crumbs, which the effect chain
 * this replaced could not promise. The keys are the ones the detail pages
 * read, so a crumb usually resolves from cache and refreshes whenever its
 * entity is invalidated.
 */
export function useBreadcrumbData(
  routeInfo: BreadcrumbRouteInfo,
): UseBreadcrumbDataResult {
  const {
    detailId,
    isListPageWithDropdowns,
    needsDesignDropdown,
    isItemDetailPage,
    isDesignDetailPage,
    isProgramDetailPage,
    isChangeOrderDetailPage,
  } = routeInfo

  // Programs and designs for the list pages' dropdowns
  const { data: programs = [] } = useQuery({
    ...programListQuery(),
    enabled: isListPageWithDropdowns,
  })
  const { data: designs = [] } = useQuery({
    ...designListQuery(),
    enabled: isListPageWithDropdowns && needsDesignDropdown,
  })

  // A change order's crumb comes from its item record, like any other item's
  const itemId =
    isItemDetailPage || isChangeOrderDetailPage ? detailId : undefined
  const item = useQuery(
    entityQuery<BreadcrumbItem>('items', itemId ?? '', 'item', !!itemId),
  )

  const designId = isDesignDetailPage
    ? detailId
    : (item.data?.designId ?? undefined)
  const design = useQuery(
    entityQuery<Design>('designs', designId ?? '', 'design', !!designId),
  )

  const programId = isProgramDetailPage
    ? detailId
    : (design.data?.programId ?? undefined)
  const program = useQuery(
    entityQuery<Program>('programs', programId ?? '', 'program', !!programId),
  )

  // Held back until every hop has settled, so the trail appears whole instead
  // of growing a segment per response. A hop that fails ends the trail where
  // it got to.
  const settled = !item.isLoading && !design.isLoading && !program.isLoading

  return {
    programs,
    designs,
    breadcrumbData: settled
      ? { item: item.data, design: design.data, program: program.data }
      : {},
  }
}
