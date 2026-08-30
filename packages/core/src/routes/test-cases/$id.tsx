// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { TestCase } from '@/lib/items/types/testcase'
import type { TestCaseDetailTab } from '@/components/tests/TestCaseDetail'
import { TestCaseDetail } from '@/components/tests'
import { TEST_CASE_DETAIL_TABS } from '@/components/tests/TestCaseDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

// Version-context params + tab. useVersionContext reads and writes
// branch/tag/commit through the URL; validateSearch strips anything the
// schema does not name, so without these a context switch (or a
// revise-checkout navigation) silently lands back on main.
const testCaseDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z.enum(TEST_CASE_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/test-cases/$id')({
  component: TestCaseDetailPage,
  validateSearch: testCaseDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      entityQuery<TestCase>('items', params.id, 'item'),
    ),
})

function TestCaseDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: testCase } = useQuery(
    entityQuery<TestCase>('items', id, 'item'),
  )
  const search = Route.useSearch()

  if (!testCase) return null

  const handleSave = async (updatedTestCase: TestCase, branchId?: string) => {
    if (!testCase.id) return

    // `PUT /items/:id` reads branchId from the query string — a save made in
    // an ECO/workspace context must land on that branch, not on main.
    const suffix = branchId ? `?branchId=${branchId}` : ''
    await apiFetch(`/api/v1/items/${testCase.id}${suffix}`, {
      method: 'PUT',
      body: JSON.stringify(updatedTestCase),
    })

    showSuccess(
      'Test case updated',
      `${updatedTestCase.itemNumber} has been updated successfully`,
    )
    await invalidate('test-cases')
  }

  const handleDelete = async () => {
    if (!testCase.id) return

    await apiFetch(`/api/v1/items/${testCase.id}`, { method: 'DELETE' })

    showSuccess('Test case deleted', `${testCase.itemNumber} has been deleted`)
    await invalidate('test-cases')
    navigate({ to: '/test-cases' })
  }

  const handleCancel = () => {
    navigate({ to: '/test-cases' })
  }

  const handleTabChange = (tab: TestCaseDetailTab) => {
    router.navigate({
      to: '/test-cases/$id',
      params: { id: testCase.id ?? '' },
      search: {
        ...search,
        tab,
      },
      replace: true,
    })
  }

  return (
    <TestCaseDetail
      testCase={testCase}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      onTransitioned={() => void invalidate('test-cases')}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
