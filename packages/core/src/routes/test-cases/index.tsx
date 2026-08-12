// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { TestCase } from '@/lib/items/types/testcase'
import type { ItemFilters } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { TestCaseTable } from '@/components/tests'
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

const testCasesSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_state: z.coerce.string().optional(),
  filter_testType: z.coerce.string().optional(),
  filter_executionStatus: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  // Version context params
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

type TestCasesSearch = z.infer<typeof testCasesSearchSchema>

// Shared by the loader and the component so both key on identical filters.
function testCaseFilters(search: TestCasesSearch): ItemFilters {
  return {
    itemType: 'TestCase',
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }
}

export const Route = createFileRoute('/test-cases/')({
  validateSearch: testCasesSearchSchema,
  component: TestCasesListPage,
  // The whole search object, so the loader can derive the very same grid
  // params the component derives — same params, same query key, one fetch.
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const filters = testCaseFilters(deps)
    await Promise.all([
      queryClient.ensureQueryData(
        itemListQuery<TestCase>(filters, gridParamsFromSearch(deps)),
      ),
      queryClient.ensureQueryData(itemCountsQuery(filters, COUNT_STATES)),
      queryClient.ensureQueryData(designListQuery()),
    ])
  },
})

function TestCasesListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()

  const filters = testCaseFilters(searchParams)

  const { data: designs = [] } = useQuery(designListQuery())
  const { data: counts } = useQuery(itemCountsQuery(filters, COUNT_STATES))

  const {
    items: testCases,
    total,
    dataGridProps,
  } = useServerDataGrid<TestCase>({
    query: itemGridQuery<TestCase>(filters),
  })

  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d) => d.id === selectedDesignId)

  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  const handleEditTestCase = (testCase: TestCase) => {
    if (testCase.id) {
      navigate({ to: '/test-cases/$id', params: { id: testCase.id } })
    }
  }

  const handleDeleteTestCase = (testCase: TestCase) => {
    if (!testCase.id) return

    confirm({
      title: 'Delete Test Case',
      description: `Are you sure you want to delete ${testCase.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/items/${testCase.id}`, { method: 'DELETE' })

          showSuccess(
            'Test case deleted',
            `${testCase.itemNumber} has been deleted`,
          )
          await invalidate('test-cases')
        } catch (error) {
          handleError(error, { title: 'Failed to delete test case' })
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
              Test Cases
            </h1>
            {selectedDesignId && (
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {contextLabel}
              </Badge>
            )}
          </div>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Verify requirements and validate parts
            {selectedDesign && (
              <span className="text-slate-500"> in {selectedDesign.name}</span>
            )}
          </p>
        </div>
        <Link
          to="/test-cases/new"
          search={selectedDesignId ? { designId: selectedDesignId } : undefined}
        >
          <Button disabled={!isEditable && context.type !== 'main'}>
            <Plus className="h-4 w-4 mr-2" />
            Create Test Case
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
          <TestCaseTable
            testCases={testCases}
            onEdit={handleEditTestCase}
            onDelete={handleDeleteTestCase}
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
