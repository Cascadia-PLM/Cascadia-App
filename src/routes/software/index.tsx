import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Software } from '@/lib/items/types/software'
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
import { apiFetch } from '@/lib/api/client'

interface SoftwareStateCounts {
  draft: number
  inReview: number
  released: number
  obsolete: number
}

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

export const Route = createFileRoute('/software/')({
  validateSearch: softwareSearchSchema,
  component: SoftwareListPage,
  loader: async () => {
    try {
      const params = new URLSearchParams({
        itemType: 'Software',
        limit: '1',
        includeCounts: 'true',
        countStates: 'Draft,InReview,Released,Obsolete',
      })
      const result = await apiFetch<{
        data: { total: number; counts?: Record<string, number> }
      }>(`/api/v1/items?${params}`)
      const counts = result.data.counts ?? {}
      return {
        counts: {
          draft: counts.Draft ?? 0,
          inReview: counts.InReview ?? 0,
          released: counts.Released ?? 0,
          obsolete: counts.Obsolete ?? 0,
        },
      }
    } catch (error) {
      console.error('Error loading software counts:', error)
      return {
        counts: { draft: 0, inReview: 0, released: 0, obsolete: 0 },
      }
    }
  },
})

function SoftwareListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { counts: initialCounts } = Route.useLoaderData()

  const [counts, setCounts] = useState<SoftwareStateCounts>(initialCounts)

  const {
    items: softwareItems,
    total,
    dataGridProps,
    refetch,
  } = useServerDataGrid<Software>({
    queryKey: ['software'],
    fetchFn: async (params) => {
      const qp = new URLSearchParams({ itemType: 'Software' })
      qp.set('limit', String(params.pageSize))
      qp.set('offset', String((params.page - 1) * params.pageSize))
      if (params.globalSearch) qp.set('search', params.globalSearch)
      if (params.sortField) qp.set('sortField', params.sortField)
      if (params.sortDirection) qp.set('sortDirection', params.sortDirection)
      if (params.columnFilters)
        qp.set('columnFilters', JSON.stringify(params.columnFilters))

      const result = await apiFetch<{
        data: { items: Array<Software>; total: number }
      }>(`/api/v1/items?${qp}`)
      return { items: result.data.items, total: result.data.total }
    },
  })

  useEffect(() => {
    setCounts(initialCounts)
  }, [initialCounts])

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

          refetch()
          router.invalidate()
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
            <CardTitle className="text-3xl">{counts.draft}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">{counts.inReview}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Released</CardDescription>
            <CardTitle className="text-3xl">{counts.released}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Obsolete</CardDescription>
            <CardTitle className="text-3xl">{counts.obsolete}</CardTitle>
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
