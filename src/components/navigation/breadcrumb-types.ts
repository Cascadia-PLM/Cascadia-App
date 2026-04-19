import type { Design } from '@/lib/types/design'
import type { Program } from '@/lib/types/program'

export interface BreadcrumbData {
  program?: { id: string; name: string; code: string }
  design?: { id: string; name: string; code: string; programId?: string | null }
  item?: { id: string; itemNumber: string; itemType: string; designId?: string }
}

export interface BreadcrumbRouteInfo {
  pathname: string
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
