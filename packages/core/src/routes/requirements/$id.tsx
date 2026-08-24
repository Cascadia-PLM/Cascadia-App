// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Requirement } from '@/lib/items/types/requirement'
import { RequirementDetail } from '@/components/requirements/RequirementDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const requirementDetailSearchSchema = z.object({
  tab: z
    .enum(['details', 'relationships', 'history'])
    .optional()
    .default('details'),
})

export const Route = createFileRoute('/requirements/$id')({
  component: RequirementDetailPage,
  validateSearch: requirementDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      entityQuery<Requirement>('requirements', params.id, 'requirement'),
    ),
})

function RequirementDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: requirement } = useQuery(
    entityQuery<Requirement>('requirements', id, 'requirement'),
  )
  const search = Route.useSearch()

  if (!requirement) return null

  const handleSave = async (updatedRequirement: Requirement) => {
    if (!requirement.id) return

    await apiFetch(`/api/v1/requirements/${requirement.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedRequirement),
    })

    showSuccess(
      'Requirement updated',
      `${updatedRequirement.itemNumber} has been updated successfully`,
    )
    await invalidate('requirements')
  }

  const handleDelete = async () => {
    if (!requirement.id) return

    await apiFetch(`/api/v1/requirements/${requirement.id}`, {
      method: 'DELETE',
    })

    showSuccess(
      'Requirement deleted',
      `${requirement.itemNumber} has been deleted`,
    )
    await invalidate('requirements')
    navigate({ to: '/requirements' })
  }

  const handleCancel = () => {
    navigate({ to: '/requirements' })
  }

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/requirements/$id',
      params: { id: requirement.id ?? '' },
      search: {
        tab: tab as 'details' | 'relationships' | 'history',
      },
      replace: true,
    })
  }

  return (
    <RequirementDetail
      requirement={requirement}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      onTransitioned={() => void invalidate('requirements')}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
