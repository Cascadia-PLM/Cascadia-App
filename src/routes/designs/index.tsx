import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { DesignTable } from '@/components/designs/DesignTable'
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

// Type counts interface matching server response
interface TypeCounts {
  design: number
  family: number
  library: number
}

// Search schema for URL validation
const designsSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_designType: z.coerce.string().optional(),
  programId: z.string().optional(),
})

type DesignWithProgram = Design & { programCode?: string; programName?: string }
type ProgramInfo = { id: string; code: string; name: string }

export const Route = createFileRoute('/designs/')({
  validateSearch: designsSearchSchema,
  component: DesignsListPage,
  loaderDeps: ({ search }) => ({
    programId: search.programId,
  }),
  loader: async ({ deps }) => {
    const { programId } = deps
    try {
      const designParams = new URLSearchParams()
      if (programId) designParams.set('programId', programId)

      const [designsResult, programsResult] = await Promise.all([
        apiFetch<{ data: { designs: Array<Design> } }>(
          `/api/v1/designs?${designParams}`,
        ),
        apiFetch<{ data: { programs: Array<ProgramInfo> } }>('/api/v1/programs'),
      ])

      // Enrich designs with program info
      const programMap = new Map<string, ProgramInfo>(
        programsResult.data.programs.map((p: ProgramInfo) => [p.id, p]),
      )
      const enrichedDesigns = designsResult.data.designs.map(
        (design: Design) => ({
          ...design,
          programCode: design.programId
            ? programMap.get(design.programId)?.code
            : undefined,
          programName: design.programId
            ? programMap.get(design.programId)?.name
            : undefined,
        }),
      )

      return {
        designs: enrichedDesigns,
        programs: programsResult.data.programs,
        total: enrichedDesigns.length,
        counts: { design: 0, family: 0, library: 0 } as TypeCounts,
      }
    } catch (error) {
      console.error('Error loading designs:', error)
      return {
        designs: [] as Array<DesignWithProgram>,
        programs: [] as Array<ProgramInfo>,
        total: 0,
        counts: { design: 0, family: 0, library: 0 } as TypeCounts,
      }
    }
  },
})

function DesignsListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { programs, counts: initialCounts } = Route.useLoaderData()
  const searchParams = Route.useSearch()

  // State for counts (loaded separately to avoid re-fetching on every filter change)
  const [counts, setCounts] = useState<TypeCounts>(initialCounts)

  // Build program map for enrichment
  const programMap = new Map<string, ProgramInfo>(
    programs.map((p: ProgramInfo) => [p.id, p]),
  )

  // Server-side DataGrid with URL state sync
  const {
    items: designs,
    total,
    dataGridProps,
    refetch,
  } = useServerDataGrid<DesignWithProgram>({
    queryKey: ['designs'],
    dependencies: { programId: searchParams.programId },
    fetchFn: async (params) => {
      const qp = new URLSearchParams()
      if (searchParams.programId) qp.set('programId', searchParams.programId)

      const result = await apiFetch<{ data: { designs: Array<Design> } }>(
        `/api/v1/designs?${qp}`,
      )
      // Enrich designs with program info
      const enrichedDesigns = result.data.designs.map((design: Design) => ({
        ...design,
        programCode: design.programId
          ? programMap.get(design.programId)?.code
          : undefined,
        programName: design.programId
          ? programMap.get(design.programId)?.name
          : undefined,
      }))
      return { items: enrichedDesigns, total: enrichedDesigns.length }
    },
  })

  // Sync counts with loader data when it changes
  useEffect(() => {
    setCounts(initialCounts)
  }, [initialCounts])

  // Navigate to detail page for editing
  const handleEditDesign = (design: Design) => {
    if (design.id) {
      navigate({ to: '/designs/$id', params: { id: design.id } })
    }
  }

  const handleArchiveDesign = (design: Design) => {
    confirm({
      title: 'Archive Design',
      description: `Are you sure you want to archive ${design.code}? The design will no longer appear in lists but data will be preserved.`,
      actionLabel: 'Archive',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/designs/${design.id}/archive`, {
            method: 'POST',
          })

          showSuccess('Design archived', `${design.code} has been archived`)

          // Refetch data to get fresh data from server
          refetch()
          router.invalidate()
        } catch (error) {
          handleError(error, { title: 'Failed to archive design' })
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
            Designs
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manage your design configurations, families, and libraries
          </p>
        </div>
        <Link
          to="/designs/new"
          search={
            searchParams.programId
              ? { programId: searchParams.programId }
              : undefined
          }
        >
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Design
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total</CardDescription>
            <CardTitle className="text-3xl">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Engineering</CardDescription>
            <CardTitle className="text-3xl text-cyan-600">
              {counts.design}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Families</CardDescription>
            <CardTitle className="text-3xl text-amber-600">
              {counts.family}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Libraries</CardDescription>
            <CardTitle className="text-3xl text-purple-600">
              {counts.library}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Designs Table */}
      <Card>
        <CardHeader>
          <CardTitle>
            {searchParams.programId
              ? `${programs.find((p: ProgramInfo) => p.id === searchParams.programId)?.name ?? 'Program'} Designs`
              : 'All Designs'}
          </CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'design' : 'designs'}
            {searchParams.programId ? ' in this program' : ' in the system'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DesignTable
            items={designs}
            onEdit={handleEditDesign}
            onArchive={handleArchiveDesign}
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
