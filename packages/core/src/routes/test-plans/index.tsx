// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { TestPlan } from '@/lib/items/types/testplan'
import type { ItemFilters } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { TestPlanTable } from '@/components/tests'
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
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

// The states behind the stat cards, counted in one request rather than one
// probe request each.
const COUNT_STATES = ['Draft', 'InReview', 'Released']

const testPlansSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_state: z.coerce.string().optional(),
  filter_status: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  // Version context params
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

type TestPlansSearch = z.infer<typeof testPlansSearchSchema>

// Shared by the loader and the component so both key on identical filters.
function testPlanFilters(search: TestPlansSearch): ItemFilters {
  return {
    itemType: 'TestPlan',
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }
}

export const Route = createFileRoute('/test-plans/')({
  validateSearch: testPlansSearchSchema,
  component: TestPlansListPage,
  // The whole search object, so the loader can derive the very same grid
  // params the component derives — same params, same query key, one fetch.
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const filters = testPlanFilters(deps)
    await Promise.all([
      queryClient.ensureQueryData(
        itemListQuery<TestPlan>(filters, gridParamsFromSearch(deps)),
      ),
      queryClient.ensureQueryData(itemCountsQuery(filters, COUNT_STATES)),
      queryClient.ensureQueryData(designListQuery()),
    ])
  },
})

function TestPlansListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()

  const filters = testPlanFilters(searchParams)

  const { data: designs = [] } = useQuery(designListQuery())
  const { data: counts } = useQuery(itemCountsQuery(filters, COUNT_STATES))

  const {
    items: testPlans,
    total,
    dataGridProps,
  } = useServerDataGrid<TestPlan>({
    query: itemGridQuery<TestPlan>(filters),
  })

  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d) => d.id === selectedDesignId)

  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  const handleEditTestPlan = (testPlan: TestPlan) => {
    if (testPlan.id) {
      navigate({ to: '/test-plans/$id', params: { id: testPlan.id } })
    }
  }

  const handleDeleteTestPlan = (testPlan: TestPlan) => {
    if (!testPlan.id) return

    confirm({
      title: 'Delete Test Plan',
      description: `Are you sure you want to delete ${testPlan.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/items/${testPlan.id}`, { method: 'DELETE' })

          showSuccess(
            'Test plan deleted',
            `${testPlan.itemNumber} has been deleted`,
          )
          await invalidate('test-plans')
        } catch (error) {
          handleError(error, { title: 'Failed to delete test plan' })
        }
      },
    })
  }

  const getContextBadgeVariant = () => {
    switch (context.type) {
      case 'main':
        return 'default'
      case 'branch':
        return 'secondary'
      case 'tag':
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
              Test Plans
            </h1>
            {selectedDesignId && (
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {contextLabel}
              </Badge>
            )}
          </div>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Organise test cases into verification campaigns
            {selectedDesign && (
              <span className="text-slate-500"> in {selectedDesign.name}</span>
            )}
          </p>
        </div>
        <Link
          to="/test-plans/new"
          search={selectedDesignId ? { designId: selectedDesignId } : undefined}
        >
          <Button disabled={!isEditable && context.type !== 'main'}>
            <Plus className="h-4 w-4 mr-2" />
            Create Test Plan
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
            <CardDescription>Draft</CardDescription>
            <CardTitle className="text-3xl">{counts?.Draft ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">{counts?.InReview ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Released</CardDescription>
            <CardTitle className="text-3xl">{counts?.Released ?? 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="pt-6">
          <TestPlanTable
            testPlans={testPlans}
            onEdit={handleEditTestPlan}
            onDelete={handleDeleteTestPlan}
            serverSidePagination={dataGridProps.serverSidePagination}
            totalRows={dataGridProps.totalRows}
            onPageChange={dataGridProps.onPageChange}
            isLoading={dataGridProps.isLoading}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
