// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { TestPlan } from '@/lib/items/types/testplan'
import type { TestPlanDetailTab } from '@/components/tests/TestPlanDetail'
import { TestPlanDetail } from '@/components/tests'
import { TEST_PLAN_DETAIL_TABS } from '@/components/tests/TestPlanDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

// Version-context params + tab. useVersionContext reads and writes
// branch/tag/commit through the URL; validateSearch strips anything the
// schema does not name, so without these a context switch (or a
// revise-checkout navigation) silently lands back on main.
const testPlanDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z.enum(TEST_PLAN_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/test-plans/$id')({
  component: TestPlanDetailPage,
  validateSearch: testPlanDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      entityQuery<TestPlan>('items', params.id, 'item'),
    ),
})

function TestPlanDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: testPlan } = useQuery(
    entityQuery<TestPlan>('items', id, 'item'),
  )
  const search = Route.useSearch()

  if (!testPlan) return null

  const handleSave = async (updatedTestPlan: TestPlan, branchId?: string) => {
    if (!testPlan.id) return

    // `PUT /items/:id` reads branchId from the query string — a save made in
    // an ECO/workspace context must land on that branch, not on main.
    const suffix = branchId ? `?branchId=${branchId}` : ''
    await apiFetch(`/api/v1/items/${testPlan.id}${suffix}`, {
      method: 'PUT',
      body: JSON.stringify(updatedTestPlan),
    })

    showSuccess(
      'Test plan updated',
      `${updatedTestPlan.itemNumber} has been updated successfully`,
    )
    await invalidate('test-plans')
  }

  const handleDelete = async () => {
    if (!testPlan.id) return

    await apiFetch(`/api/v1/items/${testPlan.id}`, { method: 'DELETE' })

    showSuccess('Test plan deleted', `${testPlan.itemNumber} has been deleted`)
    await invalidate('test-plans')
    navigate({ to: '/test-plans' })
  }

  const handleCancel = () => {
    navigate({ to: '/test-plans' })
  }

  const handleTabChange = (tab: TestPlanDetailTab) => {
    router.navigate({
      to: '/test-plans/$id',
      params: { id: testPlan.id ?? '' },
      search: {
        ...search,
        tab,
      },
      replace: true,
    })
  }

  return (
    <TestPlanDetail
      testPlan={testPlan}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      onTransitioned={() => void invalidate('test-plans')}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
