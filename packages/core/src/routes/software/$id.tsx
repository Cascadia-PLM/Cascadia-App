// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Software } from '@/lib/items/types/software'
import type { SoftwareDetailTab } from '@/components/software/SoftwareDetail'
import {
  SOFTWARE_DETAIL_TABS,
  SoftwareDetail,
} from '@/components/software/SoftwareDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  designListQuery,
  entityQuery,
  fileMetadataQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const softwareDetailSearchSchema = z.object({
  tab: z.enum(SOFTWARE_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/software/$id')({
  component: SoftwareDetailPage,
  validateSearch: softwareDetailSearchSchema,
  loader: async ({ context: { queryClient }, params }) => {
    const [software] = await Promise.all([
      queryClient.ensureQueryData(
        entityQuery<Software>('software', params.id, 'software'),
      ),
      queryClient.ensureQueryData(designListQuery()),
    ])

    if (software.buildArtifactFileId) {
      // Artifact metadata is supplementary: a stale/deleted pointer should
      // leave the detail usable with its fallback label, not fail the route.
      await queryClient
        .ensureQueryData(fileMetadataQuery(software.buildArtifactFileId))
        .catch(() => undefined)
    }
  },
})

function SoftwareDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: software } = useQuery(
    entityQuery<Software>('software', id, 'software'),
  )
  const { data: designs = [] } = useQuery(designListQuery())
  const search = Route.useSearch()

  if (!software) return null

  const handleSave = async (updated: Software) => {
    if (!software.id) return

    await apiFetch(`/api/v1/software/${software.id}`, {
      method: 'PUT',
      body: JSON.stringify(updated),
    })

    showSuccess(
      'Software updated',
      `${updated.itemNumber} has been updated successfully`,
    )
    await invalidate('software')
  }

  const handleDelete = async () => {
    if (!software.id) return

    await apiFetch(`/api/v1/software/${software.id}`, {
      method: 'DELETE',
    })

    showSuccess('Software deleted', `${software.itemNumber} has been deleted`)
    await invalidate('software')
    navigate({ to: '/software' })
  }

  const handleCancel = () => {
    navigate({ to: '/software' })
  }

  const handleTabChange = (tab: SoftwareDetailTab) => {
    router.navigate({
      to: '/software/$id',
      params: { id: software.id ?? '' },
      search: {
        tab,
      },
      replace: true,
    })
  }

  return (
    <SoftwareDetail
      software={software}
      designs={designs}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
