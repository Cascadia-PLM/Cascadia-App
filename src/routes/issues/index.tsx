import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Issue } from '@/lib/items/types/issue'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { IssueTable } from '@/components/issues/IssueTable'
import { ImportButton } from '@/components/import/ImportButton'
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
  open: number
  inProgress: number
  resolved: number
  closed: number
}

// Search schema for URL validation
const issuesSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_state: z.coerce.string().optional(),
  filter_severity: z.coerce.string().optional(),
  filter_issueType: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  // Version context params
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

export const Route = createFileRoute('/issues/')({
  validateSearch: issuesSearchSchema,
  component: IssuesListPage,
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

      // Build query params for issues
      const params = new URLSearchParams({
        itemType: 'Issue',
        limit: '10',
        offset: '0',
      })
      if (programId) params.set('programId', programId)
      if (designId) params.set('designId', designId)
      if (branch) params.set('branch', branch)
      if (tag) params.set('tag', tag)
      if (commit) params.set('commit', commit)

      // Build count params (mirror filters but not pagination)
      const countParams = new URLSearchParams({ itemType: 'Issue', limit: '1' })
      if (programId) countParams.set('programId', programId)
      if (designId) countParams.set('designId', designId)
      if (branch) countParams.set('branch', branch)
      if (tag) countParams.set('tag', tag)
      if (commit) countParams.set('commit', commit)

      // Fetch first page of issues, designs, and state counts in parallel
      const [
        issuesResult,
        designsResult,
        openCount,
        inProgressCount,
        resolvedCount,
        closedCount,
      ] = await Promise.all([
        apiFetch<{ data: { items: Array<Issue>; total: number } }>(
          `/api/items?${params.toString()}`,
        ),
        apiFetch<{ data: { designs: Array<Design> } }>('/api/designs'),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=Open`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=InProgress`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=Resolved`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=Closed`,
        ).catch(() => ({ data: { total: 0 } })),
      ])

      return {
        issues: issuesResult.data.items,
        total: issuesResult.data.total,
        counts: {
          open: openCount.data.total,
          inProgress: inProgressCount.data.total,
          resolved: resolvedCount.data.total,
          closed: closedCount.data.total,
        } as StateCounts,
        designs: designsResult.data.designs,
      }
    } catch (error) {
      console.error('Error loading issues:', error)
      return {
        issues: [] as Array<Issue>,
        total: 0,
        counts: {
          open: 0,
          inProgress: 0,
          resolved: 0,
          closed: 0,
        } as StateCounts,
        designs: [] as Array<Design>,
      }
    }
  },
})

function IssuesListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const {
    issues: initialIssues,
    total: initialTotal,
    counts: initialCounts,
    designs,
  } = Route.useLoaderData()
  const searchParams = Route.useSearch()

  // State for server-side pagination
  const [issues, setIssues] = useState<Array<Issue>>(initialIssues)
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
    setIssues(initialIssues)
    setTotal(initialTotal)
    setCounts(initialCounts)
  }, [initialIssues, initialTotal, initialCounts])

  // Handle page change for server-side pagination
  const handlePageChange = useCallback(
    async (page: number, pageSize: number) => {
      setIsLoading(true)
      try {
        const params = new URLSearchParams({
          itemType: 'Issue',
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
          data: { items: Array<Issue>; total: number }
        }>(`/api/items?${params.toString()}`)
        setIssues(result.data.items)
        setTotal(result.data.total)
      } catch (error) {
        handleError(error, { title: 'Failed to load issues' })
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

  const handleEditIssue = (issue: Issue) => {
    if (issue.id) {
      navigate({ to: '/issues/$id', params: { id: issue.id } })
    }
  }

  const handleDeleteIssue = (issue: Issue) => {
    if (!issue.id) return

    confirm({
      title: 'Delete Issue',
      description: `Are you sure you want to delete ${issue.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/issues/${issue.id}`, {
            method: 'DELETE',
          })

          setIssues(issues.filter((i) => i.id !== issue.id))
          showSuccess('Issue deleted', `${issue.itemNumber} has been deleted`)

          // Reload to get fresh data from server
          router.invalidate()
        } catch (error) {
          handleError(error, { title: 'Failed to delete issue' })
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
              Issues
            </h1>
            {selectedDesignId && (
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {contextLabel}
              </Badge>
            )}
          </div>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Track and manage quality issues, defects, and problems
            {selectedDesign && (
              <span className="text-slate-500"> in {selectedDesign.name}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton
            itemType="Issue"
            onImportComplete={() => router.invalidate()}
          />
          <Link
            to="/issues/new"
            search={
              selectedDesignId ? { designId: selectedDesignId } : undefined
            }
          >
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Create Issue
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Issues</CardDescription>
            <CardTitle className="text-3xl">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Open</CardDescription>
            <CardTitle className="text-3xl">{counts.open}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Progress</CardDescription>
            <CardTitle className="text-3xl">{counts.inProgress}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Resolved</CardDescription>
            <CardTitle className="text-3xl">{counts.resolved}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Closed</CardDescription>
            <CardTitle className="text-3xl">{counts.closed}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Issues Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Issues</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'issue' : 'issues'} in the system
            {selectedDesign && context.type !== 'main' && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                (viewing {contextLabel})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <IssueTable
            items={issues}
            onEdit={handleEditIssue}
            onDelete={handleDeleteIssue}
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
