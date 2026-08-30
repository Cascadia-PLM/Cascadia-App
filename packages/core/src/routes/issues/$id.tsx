// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Issue } from '@/lib/items/types/issue'
import type { IssueDetailTab } from '@/components/issues/IssueDetail'
import { ISSUE_DETAIL_TABS, IssueDetail } from '@/components/issues/IssueDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  designListQuery,
  entityQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const issueDetailSearchSchema = z.object({
  tab: z.enum(ISSUE_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/issues/$id')({
  component: IssueDetailPage,
  validateSearch: issueDetailSearchSchema,
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(
        entityQuery<Issue>('issues', params.id, 'issue'),
      ),
      queryClient.ensureQueryData(designListQuery()),
    ])
  },
})

function IssueDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: issue } = useQuery(entityQuery<Issue>('issues', id, 'issue'))
  const { data: designs = [] } = useQuery(designListQuery())
  const search = Route.useSearch()

  if (!issue) return null

  const handleSave = async (updatedIssue: Issue) => {
    if (!issue.id) return

    await apiFetch(`/api/v1/issues/${issue.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedIssue),
    })

    showSuccess(
      'Issue updated',
      `${updatedIssue.itemNumber} has been updated successfully`,
    )
    await invalidate('issues')
  }

  const handleDelete = async () => {
    if (!issue.id) return

    await apiFetch(`/api/v1/issues/${issue.id}`, {
      method: 'DELETE',
    })

    showSuccess('Issue deleted', `${issue.itemNumber} has been deleted`)
    await invalidate('issues')
    navigate({ to: '/issues' })
  }

  const handleCancel = () => {
    navigate({ to: '/issues' })
  }

  const handleTabChange = (tab: IssueDetailTab) => {
    router.navigate({
      to: '/issues/$id',
      params: { id: issue.id ?? '' },
      search: {
        tab,
      },
      replace: true,
    })
  }

  return (
    <IssueDetail
      issue={issue}
      designs={designs}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      onTransitioned={() => {
        showSuccess('Issue transitioned', 'The issue state has been updated')
        void invalidate('workflows')
      }}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
