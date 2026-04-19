import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Requirement } from '@/lib/items/types/requirement'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { RequirementTable } from '@/components/requirements/RequirementTable'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
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
const requirementsSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_state: z.coerce.string().optional(),
  filter_priority: z.coerce.string().optional(),
  filter_reqType: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  // Version context params
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

export const Route = createFileRoute('/requirements/')({
  validateSearch: requirementsSearchSchema,
  component: RequirementsListPage,
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

      // Build query params for requirements
      const params = new URLSearchParams({
        itemType: 'Requirement',
        limit: '10',
        offset: '0',
      })
      if (programId) params.set('programId', programId)
      if (designId) params.set('designId', designId)
      if (branch) params.set('branch', branch)
      if (tag) params.set('tag', tag)
      if (commit) params.set('commit', commit)

      // Build count params (mirror filters but not pagination)
      const countParams = new URLSearchParams({
        itemType: 'Requirement',
        limit: '1',
      })
      if (programId) countParams.set('programId', programId)
      if (designId) countParams.set('designId', designId)
      if (branch) countParams.set('branch', branch)
      if (tag) countParams.set('tag', tag)
      if (commit) countParams.set('commit', commit)

      // Fetch first page of requirements, designs, and state counts in parallel
      const [
        requirementsResult,
        designsResult,
        draftCount,
        inReviewCount,
        releasedCount,
      ] = await Promise.all([
        apiFetch<{ data: { items: Array<Requirement>; total: number } }>(
          `/api/items?${params.toString()}`,
        ),
        apiFetch<{ data: { designs: Array<Design> } }>('/api/designs'),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=Draft`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=InReview`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=Released`,
        ).catch(() => ({ data: { total: 0 } })),
      ])

      return {
        requirements: requirementsResult.data.items,
        total: requirementsResult.data.total,
        counts: {
          draft: draftCount.data.total,
          inReview: inReviewCount.data.total,
          released: releasedCount.data.total,
        } as StateCounts,
        designs: designsResult.data.designs,
      }
    } catch (error) {
      console.error('Error loading requirements:', error)
      return {
        requirements: [] as Array<Requirement>,
        total: 0,
        counts: { draft: 0, inReview: 0, released: 0 } as StateCounts,
        designs: [] as Array<Design>,
      }
    }
  },
})

function RequirementsListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const {
    requirements: initialRequirements,
    total: initialTotal,
    counts: initialCounts,
    designs,
  } = Route.useLoaderData()
  const searchParams = Route.useSearch()

  // State for server-side pagination
  const [requirements, setRequirements] =
    useState<Array<Requirement>>(initialRequirements)
  const [total, setTotal] = useState<number>(initialTotal)
  const [counts, setCounts] = useState<StateCounts>(initialCounts)
  const [isLoading, setIsLoading] = useState(false)

  // Get selected design from URL
  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d) => d.id === selectedDesignId)

  // Version context management
  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  // Sync local state with loader data when it changes
  useEffect(() => {
    setRequirements(initialRequirements)
    setTotal(initialTotal)
    setCounts(initialCounts)
  }, [initialRequirements, initialTotal, initialCounts])

  // Handle page change for server-side pagination
  const handlePageChange = useCallback(
    async (page: number, pageSize: number) => {
      setIsLoading(true)
      try {
        const params = new URLSearchParams({
          itemType: 'Requirement',
          limit: String(pageSize),
          offset: String((page - 1) * pageSize),
        })
        if (searchParams.programId)
          params.set('programId', searchParams.programId)
        if (selectedDesignId) params.set('designId', selectedDesignId)
        if (searchParams.branch) params.set('branch', searchParams.branch)
        if (searchParams.tag) params.set('tag', searchParams.tag)
        if (searchParams.commit) params.set('commit', searchParams.commit)

        const result = await apiFetch<{
          data: { items: Array<Requirement>; total: number }
        }>(`/api/items?${params.toString()}`)
        setRequirements(result.data.items)
        setTotal(result.data.total)
      } catch (error) {
        handleError(error, { title: 'Failed to load requirements' })
      } finally {
        setIsLoading(false)
      }
    },
    [
      selectedDesignId,
      searchParams.programId,
      searchParams.branch,
      searchParams.tag,
      searchParams.commit,
      handleError,
    ],
  )

  // Navigate to detail page for editing
  const handleEditRequirement = (requirement: Requirement) => {
    if (requirement.id) {
      navigate({ to: '/requirements/$id', params: { id: requirement.id } })
    }
  }

  const handleDeleteRequirement = (requirement: Requirement) => {
    if (!requirement.id) return

    confirm({
      title: 'Delete Requirement',
      description: `Are you sure you want to delete ${requirement.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/requirements/${requirement.id}`, {
            method: 'DELETE',
          })

          setRequirements(requirements.filter((r) => r.id !== requirement.id))
          showSuccess(
            'Requirement deleted',
            `${requirement.itemNumber} has been deleted`,
          )

          // Reload to get fresh data from server
          router.invalidate()
        } catch (error) {
          handleError(error, { title: 'Failed to delete requirement' })
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
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              Requirements
            </h1>
            {selectedDesignId && (
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {contextLabel}
              </Badge>
            )}
          </div>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manage your requirements library
            {selectedDesign && (
              <span className="text-slate-500"> in {selectedDesign.name}</span>
            )}
          </p>
        </div>
        <Link
          to="/requirements/new"
          search={selectedDesignId ? { designId: selectedDesignId } : undefined}
        >
          <Button disabled={!isEditable && context.type !== 'main'}>
            <Plus className="h-4 w-4 mr-2" />
            Create Requirement
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Requirements</CardDescription>
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

      {/* Requirements Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Requirements</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'requirement' : 'requirements'} in the system
            {selectedDesign && context.type !== 'main' && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                (viewing {contextLabel})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RequirementTable
            requirements={requirements}
            onEdit={handleEditRequirement}
            onDelete={handleDeleteRequirement}
            serverSidePagination
            totalRows={total}
            onPageChange={handlePageChange}
            isLoading={isLoading}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
