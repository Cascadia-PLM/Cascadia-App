// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Software } from '@cascadia/commons/items/types/software'
import type { ItemFilters } from '@/query'
import { PageContainer } from '@/components/layout'
import { SoftwareTable } from '@/components/software/SoftwareTable'
import { useVersionContext } from '@/hooks/useVersionContext'
import { useServerDataGrid } from '@/hooks/useServerDataGrid'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/hooks/useAlertDialog'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import {
  designListQuery,
  gridParamsFromSearch,
  itemCountsQuery,
  itemGridQuery,
  itemListQuery,
  lifecycleByItemTypeQuery,
  useInvalidateResources,
} from '@/query'
import { apiFetch } from '@/api/client'
import { LifecycleStateCards } from '@/components/items/LifecycleStateCards'

// Search schema for URL validation (drives useServerDataGrid state sync)
const softwareSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_softwareType: z.coerce.string().optional(),
  filter_state: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

type SoftwareSearch = z.infer<typeof softwareSearchSchema>

function softwareFilters(search: SoftwareSearch): ItemFilters {
  return {
    itemType: 'Software',
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }
}
export const Route = createFileRoute('/software/')({
  validateSearch: softwareSearchSchema,
  component: SoftwareListPage,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const filters = softwareFilters(deps)
    const grid = gridParamsFromSearch(deps)
    await Promise.all([
      queryClient.ensureQueryData(itemListQuery<Software>(filters, grid)),
      (async () => {
        const lifecycle = await queryClient.ensureQueryData(
          lifecycleByItemTypeQuery('Software'),
        )
        await queryClient.ensureQueryData(
          itemCountsQuery(
            filters,
            lifecycle.states.map((state) => state.id),
          ),
        )
      })(),
      queryClient.ensureQueryData(designListQuery()),
    ])
  },
})

function SoftwareListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()
  const filters = softwareFilters(searchParams)
  const { data: designs = [] } = useQuery(designListQuery())
  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find(
    (design) => design.id === selectedDesignId,
  )
  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  const {
    items: softwareItems,
    total,
    dataGridProps,
  } = useServerDataGrid<Software>({
    query: itemGridQuery<Software>(filters),
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

  const getContextBadgeVariant = () => {
    switch (context.type) {
      case 'branch':
        return 'secondary'
      case 'tag':
      case 'commit':
        return 'outline'
      case 'main':
      default:
        return 'default'
    }
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              Software
            </h1>
            {selectedDesignId && (
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {contextLabel}
              </Badge>
            )}
          </div>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Firmware and software configuration items with versioned source
          </p>
        </div>
        <Link
          to="/software/new"
          search={selectedDesignId ? { designId: selectedDesignId } : undefined}
        >
          <Button disabled={!isEditable && context.type !== 'main'}>
            <Plus className="h-4 w-4 mr-2" />
            Create Software
          </Button>
        </Link>
      </div>

      {/* Stats — one card per lifecycle state, from configuration */}
      <LifecycleStateCards
        itemType="Software"
        filters={filters}
        total={total}
        totalLabel="Total"
      />

      {/* Software Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Software</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'item' : 'items'} in the system
            {selectedDesign && context.type !== 'main' && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                (viewing {contextLabel})
              </span>
            )}
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
