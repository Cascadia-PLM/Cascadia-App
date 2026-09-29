// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Requirement } from '@cascadia/commons/items/types/requirement'
import type { RequirementDetailTab } from '@/components/requirements/RequirementDetail'
import type { ItemDeleteIntent } from '@/components/items/itemBranchActions'
import { deleteItemByIntent } from '@/components/items/itemBranchActions'
import {
  REQUIREMENT_DETAIL_TABS,
  RequirementDetail,
} from '@/components/requirements/RequirementDetail'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/query'
import { apiFetch } from '@/api/client'

// Version-context params + tab. useVersionContext reads and writes
// branch/tag/commit through the URL; validateSearch strips anything the
// schema does not name, so without these a context switch (or a
// revise-checkout navigation) silently lands back on main.
const requirementDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z.enum(REQUIREMENT_DETAIL_TABS).optional().default('details'),
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

  const handleDelete = async (intent: ItemDeleteIntent) => {
    if (!requirement.id) return

    await deleteItemByIntent({
      itemId: requirement.id,
      mainDeletePath: `/api/v1/requirements/${requirement.id}`,
      intent,
    })

    await invalidate('requirements', 'change-orders')
    if (intent.kind === 'change-order') {
      showSuccess(
        'Requirement removed from ECO',
        `${requirement.itemNumber} is no longer an affected item`,
      )
      return
    }

    showSuccess(
      intent.kind === 'branch'
        ? 'Branch deletion recorded'
        : 'Requirement deleted',
      intent.kind === 'branch'
        ? `${requirement.itemNumber} has been deleted on this branch`
        : `${requirement.itemNumber} has been deleted`,
    )
    navigate({ to: '/requirements' })
  }

  const handleCancel = () => {
    navigate({ to: '/requirements' })
  }

  const handleTabChange = (tab: RequirementDetailTab) => {
    router.navigate({
      to: '/requirements/$id',
      params: { id: requirement.id ?? '' },
      search: {
        ...search,
        tab,
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
