import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Program } from '@/lib/types/program'
import { PageContainer } from '@/components/layout'
import { ProgramTable } from '@/components/programs/ProgramTable'
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
import { useServerDataGrid } from '@/lib/hooks/useServerDataGrid'
import { apiFetch } from '@/lib/api/client'

// State counts interface matching server response
interface StateCounts {
  active: number
  onHold: number
  completed: number
}

// Search schema for URL validation
const programsSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_status: z.coerce.string().optional(),
})

export const Route = createFileRoute('/programs/')({
  validateSearch: programsSearchSchema,
  component: ProgramsListPage,
  loader: async () => {
    try {
      const result = await apiFetch<{
        data: {
          programs: Array<Program>
          total: number
          counts?: { active: number; onHold: number; completed: number }
        }
      }>('/api/programs?includeCounts=true')
      return {
        programs: result.data.programs,
        total: result.data.total,
        counts:
          (result.data.counts as StateCounts | undefined) ??
          ({ active: 0, onHold: 0, completed: 0 } as StateCounts),
      }
    } catch (error) {
      console.error('Error loading programs:', error)
      return {
        programs: [] as Array<Program>,
        total: 0,
        counts: { active: 0, onHold: 0, completed: 0 } as StateCounts,
      }
    }
  },
})

function ProgramsListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { counts: initialCounts } = Route.useLoaderData()

  // State for counts (loaded separately to avoid re-fetching on every filter change)
  const [counts, setCounts] = useState<StateCounts>(initialCounts)

  // Server-side DataGrid with URL state sync
  const {
    items: programs,
    total,
    dataGridProps,
    refetch,
  } = useServerDataGrid<Program>({
    queryKey: ['programs'],
    fetchFn: async (params) => {
      const qs = new URLSearchParams()
      qs.set('limit', String(params.pageSize))
      qs.set('offset', String((params.page - 1) * params.pageSize))
      if (params.sortField) qs.set('sortField', params.sortField)
      if (params.sortDirection) qs.set('sortDirection', params.sortDirection)
      if (params.globalSearch) qs.set('globalSearch', params.globalSearch)
      if (params.columnFilters) {
        qs.set('columnFilters', JSON.stringify(params.columnFilters))
      }
      const result = await apiFetch<{
        data: { programs: Array<Program>; total: number }
      }>(`/api/programs?${qs}`)
      return {
        items: result.data.programs,
        total: result.data.total,
      }
    },
  })

  // Sync counts with loader data when it changes
  useEffect(() => {
    setCounts(initialCounts)
  }, [initialCounts])

  // Navigate to detail page for editing
  const handleEditProgram = (program: Program) => {
    if (program.id) {
      navigate({ to: '/programs/$id', params: { id: program.id } })
    }
  }

  const handleDeleteProgram = (program: Program) => {
    confirm({
      title: 'Delete Program',
      description: `Are you sure you want to delete ${program.code}? This will also delete all associated products and data. This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/programs/${program.id}`, {
            method: 'DELETE',
          })

          showSuccess('Program deleted', `${program.code} has been deleted`)

          // Refetch data to get fresh data from server
          refetch()
          router.invalidate()
        } catch (error) {
          handleError(error, { title: 'Failed to delete program' })
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
            Programs
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manage your programs and their products
          </p>
        </div>
        <Link to="/programs/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Program
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Programs</CardDescription>
            <CardTitle className="text-3xl">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Active</CardDescription>
            <CardTitle className="text-3xl text-green-600">
              {counts.active}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>On Hold</CardDescription>
            <CardTitle className="text-3xl text-yellow-600">
              {counts.onHold}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Completed</CardDescription>
            <CardTitle className="text-3xl text-slate-600">
              {counts.completed}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Programs Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Programs</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'program' : 'programs'} in the system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProgramTable
            items={programs}
            onEdit={handleEditProgram}
            onDelete={handleDeleteProgram}
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
