import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Part } from '@/lib/items/types/part'
import type { Design } from '@/lib/types/design'
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
import { apiFetch } from '@/lib/api/client'

// State counts interface matching server response
interface StateCounts {
  draft: number
  inReview: number
  released: number
}

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

export const Route = createFileRoute('/parts/')({
  validateSearch: partsSearchSchema,
  component: PartsListPage,
  // Make loader depend on search params so it re-runs when they change
  loaderDeps: ({ search }) => ({
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }),
  loader: async ({ deps }) => {
    try {
      const { programId, designId, branch, tag, commit } = deps

      // Build query params for items API
      const params = new URLSearchParams({
        itemType: 'Part',
        limit: '10',
        offset: '0',
      })
      if (programId) params.set('programId', programId)
      if (designId) params.set('designId', designId)
      if (branch) params.set('branch', branch)
      if (tag) params.set('tag', tag)
      if (commit) params.set('commit', commit)

      // Build count params (mirror filters but not pagination)
      const countParams = new URLSearchParams({ itemType: 'Part', limit: '1' })
      if (programId) countParams.set('programId', programId)
      if (designId) countParams.set('designId', designId)
      if (branch) countParams.set('branch', branch)
      if (tag) countParams.set('tag', tag)
      if (commit) countParams.set('commit', commit)

      // Fetch first page of parts, designs, and state counts in parallel
      const [
        partsResult,
        designsResult,
        draftCount,
        inReviewCount,
        releasedCount,
      ] = await Promise.all([
        apiFetch<{ data: { items: Array<Part>; total: number } }>(
          `/api/v1/items?${params}`,
        ),
        apiFetch<{ data: { designs: Array<Design> } }>('/api/v1/designs'),
        apiFetch<{ data: { total: number } }>(
          `/api/v1/items?${countParams}&state=Draft`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/v1/items?${countParams}&state=InReview`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/v1/items?${countParams}&state=Released`,
        ).catch(() => ({ data: { total: 0 } })),
      ])

      return {
        parts: partsResult.data.items,
        total: partsResult.data.total,
        counts: {
          draft: draftCount.data.total,
          inReview: inReviewCount.data.total,
          released: releasedCount.data.total,
        } as StateCounts,
        designs: designsResult.data.designs,
      }
    } catch (error) {
      console.error('Error loading parts:', error)
      return {
        parts: [] as Array<Part>,
        total: 0,
        counts: { draft: 0, inReview: 0, released: 0 } as StateCounts,
        designs: [] as Array<Design>,
      }
    }
  },
})

function PartsListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { counts: initialCounts, designs } = Route.useLoaderData()
  const searchParams = Route.useSearch()

  // State for counts (loaded separately to avoid re-fetching on every filter change)
  const [counts, setCounts] = useState<StateCounts>(initialCounts)

  // Get selected design from URL
  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d: Design) => d.id === selectedDesignId)

  // Version context management
  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  // Server-side DataGrid with URL state sync
  const {
    items: parts,
    total,
    dataGridProps,
    refetch,
  } = useServerDataGrid<Part>({
    queryKey: ['parts'],
    fetchFn: async (params) => {
      const qp = new URLSearchParams({ itemType: 'Part' })
      if (searchParams.programId) qp.set('programId', searchParams.programId)
      if (selectedDesignId) qp.set('designId', selectedDesignId)
      if (searchParams.branch) qp.set('branch', searchParams.branch)
      if (searchParams.tag) qp.set('tag', searchParams.tag)
      if (searchParams.commit) qp.set('commit', searchParams.commit)
      qp.set('limit', String(params.pageSize))
      qp.set('offset', String((params.page - 1) * params.pageSize))
      if (params.globalSearch) qp.set('search', params.globalSearch)

      const result = await apiFetch<{
        data: { items: Array<Part>; total: number }
      }>(`/api/v1/items?${qp}`)
      return { items: result.data.items, total: result.data.total }
    },
    dependencies: {
      programId: searchParams.programId,
      designId: selectedDesignId,
      branch: searchParams.branch,
      tag: searchParams.tag,
      commit: searchParams.commit,
    },
  })

  // Sync counts with loader data when it changes
  useEffect(() => {
    setCounts(initialCounts)
  }, [initialCounts])

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

          // Refetch data to get fresh data from server
          refetch()
          router.invalidate()
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
            onImportComplete={() => router.invalidate()}
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

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Parts</CardDescription>
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
      </div>

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
