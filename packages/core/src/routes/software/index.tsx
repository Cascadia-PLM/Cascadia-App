// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Software } from '@/lib/items/types/software'
import type { ItemFilters } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { SoftwareTable } from '@/components/software/SoftwareTable'
import { useServerDataGrid } from '@/lib/hooks/useServerDataGrid'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  gridParamsFromSearch,
  itemCountsQuery,
  itemGridQuery,
  itemListQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

// Search schema for URL validation (drives useServerDataGrid state sync)
const softwareSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_softwareType: z.coerce.string().optional(),
  filter_state: z.coerce.string().optional(),
})

const SOFTWARE_FILTERS: ItemFilters = { itemType: 'Software' }
const COUNT_STATES = ['Draft', 'InReview', 'Released', 'Obsolete'] as const

export const Route = createFileRoute('/software/')({
  validateSearch: softwareSearchSchema,
  component: SoftwareListPage,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const grid = gridParamsFromSearch(deps)
    await Promise.all([
      queryClient.ensureQueryData(
        itemListQuery<Software>(SOFTWARE_FILTERS, grid),
      ),
      queryClient.ensureQueryData(
        itemCountsQuery(SOFTWARE_FILTERS, COUNT_STATES),
      ),
    ])
  },
})

function SoftwareListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()

  const { data: counts } = useQuery(
    itemCountsQuery(SOFTWARE_FILTERS, COUNT_STATES),
  )

  const {
    items: softwareItems,
    total,
    dataGridProps,
  } = useServerDataGrid<Software>({
    query: itemGridQuery<Software>(SOFTWARE_FILTERS),
  })

  const handleEdit = (sw: Software) => {
    if (sw.id) {
      navigate({ to: '/software/$id', params: { id: sw.id } })
    }
  }

  const handleDelete = (sw: Software) => {
    if (!sw.id) return

    confirm({
      title: 'Delete Software',
      description: `Are you sure you want to delete ${sw.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/software/${sw.id}`, {
            method: 'DELETE',
          })

          showSuccess('Software deleted', `${sw.itemNumber} has been deleted`)
          await invalidate('software')
        } catch (error) {
          handleError(error, { title: 'Failed to delete software' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Software
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Firmware and software configuration items with versioned source
          </p>
        </div>
        <Link to="/software/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Software
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total</CardDescription>
            <CardTitle className="text-3xl">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Draft</CardDescription>
            <CardTitle className="text-3xl">{counts?.Draft ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">{counts?.InReview ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Released</CardDescription>
            <CardTitle className="text-3xl">{counts?.Released ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Obsolete</CardDescription>
            <CardTitle className="text-3xl">{counts?.Obsolete ?? 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Software Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Software</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'item' : 'items'} in the system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SoftwareTable
            items={softwareItems}
            onEdit={handleEdit}
            onDelete={handleDelete}
            serverSidePagination={dataGridProps.serverSidePagination}
            serverSideOperations={dataGridProps.serverSideOperations}
            totalRows={dataGridProps.totalRows}
            isLoading={dataGridProps.isLoading}
            sorting={dataGridProps.sorting}
            onSortingChange={dataGridProps.onSortingChange}
            columnFilters={dataGridProps.columnFilters}
            onColumnFiltersChange={dataGridProps.onColumnFiltersChange}
            globalFilter={dataGridProps.globalFilter}
            onGlobalFilterChange={dataGridProps.onGlobalFilterChange}
            pagination={dataGridProps.pagination}
            onPaginationChange={dataGridProps.onPaginationChange}
            onPageChange={dataGridProps.onPageChange}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
