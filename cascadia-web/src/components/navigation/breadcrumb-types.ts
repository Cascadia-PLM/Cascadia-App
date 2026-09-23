// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { Design } from '@cascadia/commons/lib/types/design'
import type { Program } from '@cascadia/commons/lib/types/program'

export interface BreadcrumbData {
  program?: { id: string; name: string; code: string }
  design?: { id: string; name: string; code: string; programId?: string | null }
  item?: {
    id: string
    itemNumber: string
    itemType: string
    designId?: string | null
  }
}

export interface BreadcrumbRouteInfo {
  pathname: string
  /** The `$id` of the detail page shown, or undefined on any other page. */
  detailId: string | undefined
  isItemListPage: boolean
  isItemDetailPage: boolean
  isDesignDetailPage: boolean
  isProgramDetailPage: boolean
  isChangeOrderDetailPage: boolean
  isChangeOrderListPage: boolean
  isDesignListPage: boolean
  isProgramListPage: boolean
  isListPageWithDropdowns: boolean
  needsDesignDropdown: boolean
}

export interface UseBreadcrumbDataResult {
  programs: Array<Program>
  designs: Array<Design>
  breadcrumbData: BreadcrumbData
}

export interface BreadcrumbDropdownProps {
  type: 'program' | 'design'
  items: Array<{ id: string; name: string; code: string; designType?: string }>
  selectedId?: string
  onSelect: (id: string) => void
  placeholder: string
}

export interface BreadcrumbLinkProps {
  to: string
  params?: { id: string }
  label: string
  showChevron?: boolean
}
