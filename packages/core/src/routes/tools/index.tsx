// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Tool } from '@/lib/items/types/tool'
import type { ItemFilters } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { ToolTable } from '@/components/tools/ToolTable'
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
const toolsSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_toolType: z.coerce.string().optional(),
  filter_toolStatus: z.coerce.string().optional(),
})

const TOOL_FILTERS: ItemFilters = { itemType: 'Tool' }
const COUNT_STATES = ['Draft', 'Active', 'Maintenance', 'Retired'] as const

export const Route = createFileRoute('/tools/')({
  validateSearch: toolsSearchSchema,
  component: ToolsListPage,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const grid = gridParamsFromSearch(deps)
    await Promise.all([
      queryClient.ensureQueryData(itemListQuery<Tool>(TOOL_FILTERS, grid)),
      queryClient.ensureQueryData(itemCountsQuery(TOOL_FILTERS, COUNT_STATES)),
    ])
  },
})

function ToolsListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()

  const { data: counts } = useQuery(itemCountsQuery(TOOL_FILTERS, COUNT_STATES))

  // Server-side DataGrid with URL state sync
  const {
    items: tools,
    total,
    dataGridProps,
  } = useServerDataGrid<Tool>({
    query: itemGridQuery<Tool>(TOOL_FILTERS),
  })

  const handleEditTool = (tool: Tool) => {
    if (tool.id) {
      navigate({ to: '/tools/$id', params: { id: tool.id } })
    }
  }

  const handleDeleteTool = (tool: Tool) => {
    if (!tool.id) return

    confirm({
      title: 'Delete Tool',
      description: `Are you sure you want to delete ${tool.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/tools/${tool.id}`, {
            method: 'DELETE',
          })

          showSuccess('Tool deleted', `${tool.itemNumber} has been deleted`)
          await invalidate('tools')
        } catch (error) {
          handleError(error, { title: 'Failed to delete tool' })
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
            Tools
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manufacturing tools and equipment inventory
          </p>
        </div>
        <Link to="/tools/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Tool
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Tools</CardDescription>
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
            <CardDescription>Active</CardDescription>
            <CardTitle className="text-3xl">{counts?.Active ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Maintenance</CardDescription>
            <CardTitle className="text-3xl">
              {counts?.Maintenance ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Retired</CardDescription>
            <CardTitle className="text-3xl">{counts?.Retired ?? 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Tools Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Tools</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'tool' : 'tools'} in the system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ToolTable
            items={tools}
            onEdit={handleEditTool}
            onDelete={handleDeleteTool}
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
