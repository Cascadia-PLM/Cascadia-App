import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Tool } from '@/lib/items/types/tool'
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
import { apiFetch } from '@/lib/api/client'

interface ToolStateCounts {
  draft: number
  active: number
  maintenance: number
  retired: number
}

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

export const Route = createFileRoute('/tools/')({
  validateSearch: toolsSearchSchema,
  component: ToolsListPage,
  loader: async () => {
    try {
      // Fetch per-lifecycle-state counts in a single request
      const params = new URLSearchParams({
        itemType: 'Tool',
        limit: '1',
        includeCounts: 'true',
        countStates: 'Draft,Active,Maintenance,Retired',
      })
      const result = await apiFetch<{
        data: { total: number; counts?: Record<string, number> }
      }>(`/api/v1/items?${params}`)
      const counts = result.data.counts ?? {}
      return {
        counts: {
          draft: counts.Draft ?? 0,
          active: counts.Active ?? 0,
          maintenance: counts.Maintenance ?? 0,
          retired: counts.Retired ?? 0,
        },
      }
    } catch (error) {
      console.error('Error loading tool counts:', error)
      return {
        counts: { draft: 0, active: 0, maintenance: 0, retired: 0 },
      }
    }
  },
})

function ToolsListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { counts: initialCounts } = Route.useLoaderData()

  // State for counts (loaded separately to avoid re-fetching on every filter change)
  const [counts, setCounts] = useState<ToolStateCounts>(initialCounts)

  // Server-side DataGrid with URL state sync
  const {
    items: tools,
    total,
    dataGridProps,
    refetch,
  } = useServerDataGrid<Tool>({
    queryKey: ['tools'],
    fetchFn: async (params) => {
      const qp = new URLSearchParams({ itemType: 'Tool' })
      qp.set('limit', String(params.pageSize))
      qp.set('offset', String((params.page - 1) * params.pageSize))
      if (params.globalSearch) qp.set('search', params.globalSearch)
      if (params.sortField) qp.set('sortField', params.sortField)
      if (params.sortDirection) qp.set('sortDirection', params.sortDirection)
      if (params.columnFilters)
        qp.set('columnFilters', JSON.stringify(params.columnFilters))

      const result = await apiFetch<{
        data: { items: Array<Tool>; total: number }
      }>(`/api/v1/items?${qp}`)
      return { items: result.data.items, total: result.data.total }
    },
  })

  // Sync counts with loader data when it changes
  useEffect(() => {
    setCounts(initialCounts)
  }, [initialCounts])

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

          // Refetch data to get fresh data from server
          refetch()
          router.invalidate()
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
            <CardTitle className="text-3xl">{counts.draft}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Active</CardDescription>
            <CardTitle className="text-3xl">{counts.active}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Maintenance</CardDescription>
            <CardTitle className="text-3xl">{counts.maintenance}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Retired</CardDescription>
            <CardTitle className="text-3xl">{counts.retired}</CardTitle>
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
