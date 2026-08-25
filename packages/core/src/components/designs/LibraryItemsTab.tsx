// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import type { DesignItem, GridParams } from '@/lib/query'
import { useServerDataGrid } from '@/lib/hooks/useServerDataGrid'
import { designItemsGridQuery } from '@/lib/query'
import { Badge } from '@/components/ui'
import { DataGrid } from '@/components/ui/DataGrid'
import { StateBadge } from '@/components/items/StateBadge'
import { ItemLink } from '@/components/items/ItemLink'
import { getItemDetailPath } from '@/lib/items/item-type-ui'

interface LibraryItemsTabProps {
  designId: string
  versionContext: VersionContext
  isHistoricalView: boolean
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

const columns: Array<DataGridColumn<DesignItem>> = [
  {
    id: 'itemNumber',
    header: 'Item Number',
    accessorKey: 'itemNumber',
    enableFiltering: true,
    filterType: 'text',
    filterPlaceholder: 'Filter...',
    cell: ({ row }) => (
      <ItemLink
        itemType={row.original.itemType}
        itemId={row.original.id}
        className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-medium"
      >
        {row.original.itemNumber}
      </ItemLink>
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
    // Library items span item types, each with its own lifecycle — a free
    // text filter rather than one type's state list
    filterType: 'text',
    filterPlaceholder: 'Filter state...',
    cell: ({ row, getValue }) => (
      <StateBadge
        itemType={row.original.itemType}
        state={getValue() as string}
        className="text-xs"
      />
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
  const { items, dataGridProps } = useServerDataGrid<DesignItem>({
    query: (grid: GridParams) =>
      designItemsGridQuery(designId, grid, {
        branch: versionContext.branchId,
        tag: versionContext.tagId,
        commit: versionContext.commitId,
      }),
  })

  return (
    <DataGrid
      data={items}
      columns={columns}
      getRowId={(row) => row.id}
      getRowUrl={(row) => getItemDetailPath(row.itemType, row.id) ?? undefined}
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
