// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Part } from '@/lib/items/types/part'
import type { PartDetailTab } from '@/components/parts/PartDetail'
import { PART_DETAIL_TABS, PartDetail } from '@/components/parts/PartDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useResourceMutation } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

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

  // The navigation is why this one is a mutation rather than a plain handler:
  // `useResourceMutation` registers the invalidation before running onSuccess,
  // so /parts is already refetching when we land on it instead of rendering the
  // pre-delete cache and then flickering.
  const remove = useResourceMutation({
    mutationFn: (deleted: Part) =>
      apiFetch(`/api/v1/parts/${deleted.id}`, { method: 'DELETE' }),
    invalidates: ['parts'],
    onSuccess: (_data, deleted) => {
      showSuccess('Part deleted', `${deleted.itemNumber} has been deleted`)
      navigate({ to: '/parts' })
    },
  })

  if (!part) return null

  const handleSave = async (updatedPart: Part) => {
    if (!part.id) return
    await save.mutateAsync(updatedPart)
  }

  const handleDelete = async () => {
    if (!part.id) return
    await remove.mutateAsync(part)
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
