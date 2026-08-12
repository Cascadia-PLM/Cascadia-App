// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import type { Issue } from '@/lib/items/types/issue'
import { IssueDetail } from '@/components/issues/IssueDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { designListQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

// Search schema to accept default designIds (comma-separated string in URL)
const newIssueSearchSchema = z.object({
  // Comma-separated UUID string in URL, parsed in component
  designIds: z.string().optional(),
  // Backward compat: single designId
  designId: z.string().uuid().optional(),
})

export const Route = createFileRoute('/issues/new')({
  validateSearch: newIssueSearchSchema,
  component: NewIssuePage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(designListQuery()),
})

function NewIssuePage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: designs = [] } = useQuery(designListQuery())
  const searchParams = Route.useSearch()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async (issue: Issue) => {
    setIsSubmitting(true)
    try {
      const payload = {
        ...issue,
        itemType: 'Issue',
      }
      const result = await apiFetch<{ data: { item: Issue } }>(
        '/api/v1/items',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )

      showSuccess(
        'Issue created',
        `${issue.itemNumber || result.data.item.itemNumber} has been created successfully`,
      )

      await invalidate('issues')

      navigate({ to: '/issues/$id', params: { id: result.data.item.id! } })
    } catch (error) {
      handleError(error, { title: 'Failed to create issue' })
      throw error
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    navigate({ to: '/issues' })
  }

  // Parse comma-separated designIds from URL and combine with backward compat designId
  const parsedDesignIds = searchParams.designIds
    ? searchParams.designIds.split(',').filter((id: string) => id.length > 0)
    : []
  const defaultDesignIds = [
    ...parsedDesignIds,
    ...(searchParams.designId ? [searchParams.designId] : []),
  ]

  return (
    <IssueDetail
      designs={designs}
      defaultDesignIds={defaultDesignIds}
      onSave={handleSave}
      onCancel={handleCancel}
      isSubmitting={isSubmitting}
    />
  )
}
