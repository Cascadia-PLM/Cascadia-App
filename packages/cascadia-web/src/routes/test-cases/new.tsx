// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import type { TestCase } from '@/lib/items/types/testcase'
import { TestCaseDetail } from '@/components/tests'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { designListQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const newTestCaseSearchSchema = z.object({
  designId: z.string().uuid().optional(),
  // Set when arriving from a test plan's "Add Test Case" button.
  testPlanId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/test-cases/new')({
  validateSearch: newTestCaseSearchSchema,
  component: NewTestCasePage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(designListQuery()),
})

function NewTestCasePage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: designs = [] } = useQuery(designListQuery())
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (testCase: TestCase, branchId?: string) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...testCase,
        itemType: 'TestCase',
        ...(branchId && { branchId }),
      }
      const result = await apiFetch<{ data: { item: TestCase } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      showSuccess(
        'Test case created',
        `${testCase.itemNumber} has been created successfully`,
      )

      await invalidate('test-cases')

      navigate({
        to: '/test-cases/$id',
        params: { id: result.data.item.id! },
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create test case' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/test-cases' })
  }

  return (
    <TestCaseDetail
      designs={designs}
      defaultDesignId={searchParams.designId}
      defaultTestPlanId={searchParams.testPlanId}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
