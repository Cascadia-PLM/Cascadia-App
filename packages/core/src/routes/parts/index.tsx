// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Part } from '@/lib/items/types/part'
import type { ItemFilters } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { PartTable } from '@/components/parts/PartTable'
import { ImportButton } from '@/components/import'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { useServerDataGrid } from '@/lib/hooks/useServerDataGrid'
import {
  Badge,
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
  designListQuery,
  gridParamsFromSearch,
  itemCountsQuery,
  itemGridQuery,
  itemListQuery,
  lifecycleByItemTypeQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'
import { LifecycleStateCards } from '@/components/items/LifecycleStateCards'

// Search schema for URL validation
const partsSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_state: z.coerce.string().optional(),
  filter_partType: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  // Version context params
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

type PartsSearch = z.infer<typeof partsSearchSchema>

// Built from the URL by both the loader and the page, so the two derive the
// same query key and share one fetch.
function partFilters(search: PartsSearch): ItemFilters {
  return {
    itemType: 'Part',
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }
}

export const Route = createFileRoute('/parts/')({
  validateSearch: partsSearchSchema,
  component: PartsListPage,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const filters = partFilters(deps)
    const grid = gridParamsFromSearch(deps)
    await Promise.all([
      queryClient.ensureQueryData(itemListQuery<Part>(filters, grid)),
      (async () => {
        const lifecycle = await queryClient.ensureQueryData(
          lifecycleByItemTypeQuery('Part'),
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

function PartsListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()

  const filters = partFilters(searchParams)

  const { data: designs = [] } = useQuery(designListQuery())

  // Get selected design from URL
  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d) => d.id === selectedDesignId)

  // Version context management
  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  // Server-side DataGrid with URL state sync
  const {
    items: parts,
    total,
    dataGridProps,
  } = useServerDataGrid<Part>({
    query: itemGridQuery<Part>(filters),
  })

  // Navigate to detail page for editing
  const handleEditPart = (part: Part) => {
    if (part.id) {
      navigate({ to: '/parts/$id', params: { id: part.id } })
    }
  }

  const handleDeletePart = (part: Part) => {
    if (!part.id) return

    confirm({
      title: 'Delete Part',
      description: `Are you sure you want to delete ${part.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/parts/${part.id}`, {
            method: 'DELETE',
          })

          showSuccess('Part deleted', `${part.itemNumber} has been deleted`)
          await invalidate('parts')
        } catch (error) {
          handleError(error, { title: 'Failed to delete part' })
        }
      },
    })
  }

  // Get context badge variant
  const getContextBadgeVariant = () => {
    switch (context.type) {
      case 'main':
        return 'default'
      case 'branch':
        return 'secondary'
      case 'tag':
        return 'outline'
      case 'commit':
        return 'outline'
      default:
        return 'default'
    }
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Parts
          </h1>
          {selectedDesignId && (
            <Badge variant={getContextBadgeVariant()} className="text-sm">
              {contextLabel}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 mt-4">
          <ImportButton
            designId={selectedDesignId}
            onImportComplete={() => {
              void invalidate('parts')
            }}
          />
          <Link
            to="/parts/new"
            search={
              selectedDesignId ? { designId: selectedDesignId } : undefined
            }
            data-testid="create-part-link"
          >
            <Button
              disabled={!isEditable && context.type !== 'main'}
              data-testid="create-part-button"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Part
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats — one card per lifecycle state, from configuration */}
      <LifecycleStateCards
        itemType="Part"
        filters={filters}
        total={total}
        totalLabel="Total Parts"
      />

      {/* Parts Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Parts</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'part' : 'parts'} in the system
            {selectedDesign && context.type !== 'main' && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                (viewing {contextLabel})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PartTable
            items={parts}
            onEdit={handleEditPart}
            onDelete={handleDeletePart}
            // Server-side operations with URL state sync
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
