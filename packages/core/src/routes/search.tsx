// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { z } from 'zod'
import type { DataGridColumn } from '@/components/ui'
import type { SearchResultRow } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataGrid,
} from '@/components/ui'
import { getStateBadgeVariant } from '@/components/bom/helpers'
import {
  ITEM_STATE_OPTIONS,
  ITEM_TYPE_OPTIONS,
  getItemDetailPath,
  getItemTypeIcon,
  getItemTypeLabel,
} from '@/lib/items/item-type-ui'
import { useServerDataGrid } from '@/lib/hooks/useServerDataGrid'
import {
  designListQuery,
  gridParamsFromSearch,
  programListQuery,
  searchResultsGridQuery,
} from '@/lib/query'

// Search schema for URL validation. `search` doubles as the search term the
// header search box hands off (and the grid's global filter input).
const searchPageSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_itemType: z.coerce.string().optional(),
  filter_itemNumber: z.coerce.string().optional(),
  filter_name: z.coerce.string().optional(),
  filter_state: z.coerce.string().optional(),
  filter_program: z.coerce.string().optional(),
  filter_design: z.coerce.string().optional(),
})

export const Route = createFileRoute('/search')({
  validateSearch: searchPageSchema,
  component: SearchResultsPage,
  // The whole search object, so the loader can derive the very same grid
  // params the component derives — same params, same query key, one fetch.
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const grid = gridParamsFromSearch(deps)
    await Promise.all([
      queryClient.ensureQueryData(searchResultsGridQuery(grid)),
      queryClient.ensureQueryData(programListQuery()),
      queryClient.ensureQueryData(designListQuery()),
    ])
  },
})

function SearchResultsPage() {
  const searchParams = Route.useSearch()

  const { data: programs = [] } = useQuery(programListQuery())
  const { data: designs = [] } = useQuery(designListQuery())

  const {
    items: results,
    total,
    dataGridProps,
  } = useServerDataGrid<SearchResultRow>({
    query: searchResultsGridQuery,
  })

  const columns = useMemo<Array<DataGridColumn<SearchResultRow>>>(
    () => [
      {
        id: 'itemType',
        header: 'Type',
        accessorKey: 'itemType',
        enableFiltering: true,
        filterType: 'multiSelect',
        filterOptions: ITEM_TYPE_OPTIONS,
        meta: { width: '160px' },
        cell: ({ row }) => {
          const Icon = getItemTypeIcon(row.original.itemType)
          return (
            <span className="flex items-center gap-2 text-sm">
              <Icon
                size={16}
                className="text-slate-500 dark:text-slate-400 shrink-0"
              />
              {getItemTypeLabel(row.original.itemType)}
            </span>
          )
        },
      },
      {
        id: 'itemNumber',
        header: 'Item Number',
        accessorKey: 'itemNumber',
        enableFiltering: true,
        filterType: 'text',
        filterPlaceholder: 'Filter...',
        cell: ({ row }) => {
          const path = getItemDetailPath(row.original.itemType, row.original.id)
          return path ? (
            <Link
              to={path}
              className="font-medium text-sky-600 hover:text-sky-800 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
            >
              {row.original.itemNumber}
            </Link>
          ) : (
            <span className="font-medium">{row.original.itemNumber}</span>
          )
        },
      },
      {
        id: 'revision',
        header: 'Rev',
        accessorKey: 'revision',
        enableFiltering: false,
        meta: { width: '64px' },
        cell: ({ getValue }) => (getValue() as string | null) || '-',
      },
      {
        id: 'name',
        header: 'Name',
        accessorKey: 'name',
        enableFiltering: true,
        filterType: 'text',
        filterPlaceholder: 'Filter...',
        cell: ({ getValue }) => (getValue() as string | null) || '-',
      },
      {
        id: 'state',
        header: 'State',
        accessorKey: 'state',
        enableFiltering: true,
        filterType: 'multiSelect',
        filterOptions: ITEM_STATE_OPTIONS,
        cell: ({ getValue }) => {
          const value = getValue() as string | null
          if (!value) return '-'
          return <Badge variant={getStateBadgeVariant(value)}>{value}</Badge>
        },
      },
      {
        id: 'program',
        header: 'Program',
        accessorFn: (row) => row.programName,
        enableFiltering: true,
        filterType: 'select',
        filterOptions: programs.map((p) => ({ label: p.name, value: p.id })),
        cell: ({ row }) => row.original.programName ?? '-',
      },
      {
        id: 'design',
        header: 'Design',
        accessorFn: (row) => row.designCode,
        enableFiltering: true,
        filterType: 'select',
        filterOptions: designs.map((d) => ({
          label: `${d.code} — ${d.name}`,
          value: d.id,
        })),
        cell: ({ row }) =>
          row.original.designCode ? (
            <span className="text-sm">
              <span className="font-mono">{row.original.designCode}</span>
              {row.original.designName && (
                <span className="text-slate-500 dark:text-slate-400">
                  {' '}
                  · {row.original.designName}
                </span>
              )}
            </span>
          ) : (
            '-'
          ),
      },
      {
        id: 'modifiedAt',
        header: 'Modified',
        accessorKey: 'modifiedAt',
        enableFiltering: false,
        meta: { width: '110px' },
        cell: ({ getValue }) => {
          const value = getValue() as string | null
          return value ? new Date(value).toLocaleDateString() : '-'
        },
      },
    ],
    [programs, designs],
  )

  const term = searchParams.search?.trim()

  return (
    <PageContainer>
      <div>
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
          Search Results
        </h1>
        <p className="text-slate-600 dark:text-slate-400 mt-2">
          {term
            ? `Items matching "${term}" across all item types`
            : 'Search and filter items across all item types'}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'item' : 'items'} found
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataGrid
            data={results}
            columns={columns}
            getRowId={(row) => row.id}
            enableGlobalFilter
            enableContextMenu
            getRowUrl={(row) =>
              getItemDetailPath(row.itemType, row.id) ?? undefined
            }
            emptyMessage={
              term ? `No items found for "${term}"` : 'No items found'
            }
            emptyDescription="Try a different search term, or broaden the type, program, or design filters."
            {...dataGridProps}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
