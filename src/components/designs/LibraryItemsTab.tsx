import { Link } from '@tanstack/react-router'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import { useServerDataGrid } from '@/lib/hooks/useServerDataGrid'
import { apiFetch } from '@/lib/api/client'
import { Badge } from '@/components/ui'
import { DataGrid } from '@/components/ui/DataGrid'

interface Item {
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
  modifiedAt: string
}

interface LibraryItemsTabProps {
  designId: string
  versionContext: VersionContext
  isHistoricalView: boolean
}

const getItemRoute = (itemType: string, itemId: string) => {
  switch (itemType) {
    case 'Part':
      return `/parts/${itemId}` as const
    case 'Document':
      return `/documents/${itemId}` as const
    case 'Requirement':
      return `/requirements/${itemId}` as const
    default:
      return `/parts/${itemId}` as const
  }
}

const getStateBadgeVariant = (state: string) => {
  switch (state) {
    case 'Released':
      return 'success' as const
    case 'Draft':
      return 'secondary' as const
    case 'InReview':
      return 'warning' as const
    case 'Obsolete':
      return 'outline' as const
    default:
      return 'default' as const
  }
}

const getTypeBadgeVariant = (itemType: string) => {
  switch (itemType) {
    case 'Part':
      return 'default' as const
    case 'Document':
      return 'secondary' as const
    case 'Requirement':
      return 'outline' as const
    default:
      return 'default' as const
  }
}

const columns: Array<DataGridColumn<Item>> = [
  {
    id: 'itemNumber',
    header: 'Item Number',
    accessorKey: 'itemNumber',
    enableFiltering: true,
    filterType: 'text',
    filterPlaceholder: 'Filter...',
    cell: ({ row }) => (
      <Link
        to={getItemRoute(row.original.itemType, row.original.id)}
        className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-medium"
      >
        {row.original.itemNumber}
      </Link>
    ),
  },
  {
    id: 'itemType',
    header: 'Type',
    accessorKey: 'itemType',
    enableFiltering: true,
    filterType: 'multiSelect',
    filterOptions: [
      { label: 'Part', value: 'Part' },
      { label: 'Document', value: 'Document' },
      { label: 'Requirement', value: 'Requirement' },
    ],
    cell: ({ getValue }) => (
      <Badge
        variant={getTypeBadgeVariant(getValue() as string)}
        className="text-xs"
      >
        {getValue() as string}
      </Badge>
    ),
  },
  {
    id: 'name',
    header: 'Name',
    accessorKey: 'name',
    enableFiltering: true,
    filterType: 'text',
    filterPlaceholder: 'Filter...',
  },
  {
    id: 'revision',
    header: 'Revision',
    accessorKey: 'revision',
    meta: { align: 'center' },
  },
  {
    id: 'state',
    header: 'State',
    accessorKey: 'state',
    enableFiltering: true,
    filterType: 'multiSelect',
    filterOptions: [
      { label: 'Draft', value: 'Draft' },
      { label: 'InReview', value: 'InReview' },
      { label: 'Released', value: 'Released' },
      { label: 'Obsolete', value: 'Obsolete' },
    ],
    cell: ({ getValue }) => (
      <Badge
        variant={getStateBadgeVariant(getValue() as string)}
        className="text-xs"
      >
        {getValue() as string}
      </Badge>
    ),
  },
  {
    id: 'modifiedAt',
    header: 'Modified',
    accessorKey: 'modifiedAt',
    cell: ({ getValue }) => {
      const val = getValue() as string
      return (
        <span className="text-slate-700 dark:text-slate-300">
          {val ? new Date(val).toLocaleDateString() : '-'}
        </span>
      )
    },
  },
]

export function LibraryItemsTab({
  designId,
  versionContext,
  isHistoricalView,
}: LibraryItemsTabProps) {
  const { items, dataGridProps } = useServerDataGrid<Item>({
    queryKey: ['design-items', designId],
    fetchFn: async (params) => {
      const queryParams = new URLSearchParams()
      if (params.pageSize) queryParams.set('limit', String(params.pageSize))
      if (params.page && params.pageSize)
        queryParams.set('offset', String((params.page - 1) * params.pageSize))
      if (versionContext.branchId)
        queryParams.set('branch', versionContext.branchId)
      if (versionContext.tagId) queryParams.set('tag', versionContext.tagId)
      if (versionContext.commitId)
        queryParams.set('commit', versionContext.commitId)
      if (params.globalSearch) queryParams.set('search', params.globalSearch)

      const result = await apiFetch<{
        data: { items: Array<Item>; total: number }
      }>(`/api/designs/${designId}/items?${queryParams.toString()}`)
      return { items: result.data.items, total: result.data.total }
    },
    dependencies: {
      designId,
      branch: versionContext.branchId,
      tag: versionContext.tagId,
      commit: versionContext.commitId,
    },
  })

  return (
    <DataGrid
      data={items}
      columns={columns}
      getRowId={(row) => row.id}
      getRowUrl={(row) => getItemRoute(row.itemType, row.id)}
      emptyMessage={
        isHistoricalView
          ? 'No items found at this point in history'
          : 'No items in this library'
      }
      emptyDescription="Items added to this library design will appear here."
      exportFilename="library-items"
      defaultSorting={[{ id: 'itemNumber', desc: false }]}
      {...dataGridProps}
    />
  )
}
