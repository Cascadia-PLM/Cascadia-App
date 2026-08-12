// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import type { TestPlan } from '@/lib/items/types/testplan'
import { TestPlanDetail } from '@/components/tests'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { designListQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const newTestPlanSearchSchema = z.object({
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/test-plans/new')({
  validateSearch: newTestPlanSearchSchema,
  component: NewTestPlanPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(designListQuery()),
})

function NewTestPlanPage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: designs = [] } = useQuery(designListQuery())
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (testPlan: TestPlan, branchId?: string) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...testPlan,
        itemType: 'TestPlan',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: TestPlan } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      showSuccess(
        'Test plan created',
        `${testPlan.itemNumber} has been created successfully`,
      )

      await invalidate('test-plans')

      navigate({
        to: '/test-plans/$id',
        params: { id: result.data.item.id! },
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create test plan' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/test-plans' })
  }

  return (
    <TestPlanDetail
      designs={designs}
      defaultDesignId={searchParams.designId}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
