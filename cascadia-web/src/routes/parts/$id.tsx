// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Part } from '@cascadia/commons/items/types/part'
import type { PartDetailTab } from '@/components/parts/PartDetail'
import type { ItemDeleteIntent } from '@/components/items/itemBranchActions'
import { PART_DETAIL_TABS, PartDetail } from '@/components/parts/PartDetail'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { entityQuery, useResourceMutation } from '@/query'
import { apiFetch } from '@/api/client'
import { deleteItemByIntent } from '@/components/items/itemBranchActions'

// Search schema for version context URL params and tab
const partDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z.enum(PART_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/parts/$id')({
  component: PartDetailPage,
  validateSearch: partDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(entityQuery<Part>('parts', params.id, 'part')),
})

function PartDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const { id } = Route.useParams()
  const { data: part } = useQuery(entityQuery<Part>('parts', id, 'part'))
  const search = Route.useSearch()

  const save = useResourceMutation({
    mutationFn: (updated: Part) =>
      apiFetch(`/api/v1/parts/${updated.id}`, {
        method: 'PUT',
        body: JSON.stringify(updated),
      }),
    invalidates: ['parts'],
    onSuccess: (_data, updated) => {
      showSuccess(
        'Part updated',
        `${updated.itemNumber} has been updated successfully`,
      )
    },
  })

  // Delete means three different things depending on the selected version
  // context. Main deletes the Part itself, a workspace records a branch
  // deletion, and an ECO removes the Part from reviewed scope while
  // explicitly discarding its working copy and checkout.
  const remove = useResourceMutation({
    mutationFn: ({
      deleted,
      intent,
    }: {
      deleted: Part
      intent: ItemDeleteIntent
    }) =>
      deleteItemByIntent({
        itemId: deleted.id!,
        mainDeletePath: `/api/v1/parts/${deleted.id}`,
        intent,
      }),
    invalidates: ['parts', 'change-orders'],
    onSuccess: (_data, { deleted, intent }) => {
      if (intent.kind === 'change-order') {
        showSuccess(
          'Part removed from ECO',
          `${deleted.itemNumber} is no longer an affected item`,
        )
        return
      }

      showSuccess(
        intent.kind === 'branch' ? 'Branch deletion recorded' : 'Part deleted',
        intent.kind === 'branch'
          ? `${deleted.itemNumber} has been deleted on this branch`
          : `${deleted.itemNumber} has been deleted`,
      )
      navigate({ to: '/parts' })
    },
  })

  if (!part) return null

  const handleSave = async (updatedPart: Part) => {
    if (!part.id) return
    await save.mutateAsync(updatedPart)
  }

  const handleDelete = async (intent: ItemDeleteIntent) => {
    if (!part.id) return
    await remove.mutateAsync({ deleted: part, intent })
  }

  const handleCancel = () => {
    navigate({ to: '/parts' })
  }

  const handleTabChange = (tab: PartDetailTab) => {
    router.navigate({
      to: '/parts/$id',
      params: { id: part.id ?? '' },
      search: {
        ...search,
        tab,
      },
      replace: true,
    })
  }

  return (
    <PartDetail
      part={part}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
