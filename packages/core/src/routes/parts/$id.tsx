// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Part } from '@/lib/items/types/part'
import { PartDetail } from '@/components/parts/PartDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

// Search schema for version context URL params and tab
const partDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z
    .enum([
      'details',
      'gallery',
      'relationships',
      'sources',
      'work-instructions',
      'history',
    ])
    .optional()
    .default('details'),
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
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: part } = useQuery(entityQuery<Part>('parts', id, 'part'))
  const search = Route.useSearch()

  if (!part) return null

  const handleSave = async (updatedPart: Part) => {
    if (!part.id) return

    await apiFetch(`/api/v1/parts/${part.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedPart),
    })

    showSuccess(
      'Part updated',
      `${updatedPart.itemNumber} has been updated successfully`,
    )
    await invalidate('parts')
  }

  const handleDelete = async () => {
    if (!part.id) return

    await apiFetch(`/api/v1/parts/${part.id}`, {
      method: 'DELETE',
    })

    showSuccess('Part deleted', `${part.itemNumber} has been deleted`)
    await invalidate('parts')
    navigate({ to: '/parts' })
  }

  const handleCancel = () => {
    navigate({ to: '/parts' })
  }

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/parts/$id',
      params: { id: part.id ?? '' },
      search: {
        ...search,
        tab: tab as
          | 'details'
          | 'gallery'
          | 'relationships'
          | 'sources'
          | 'work-instructions'
          | 'history',
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
