// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { InterfaceItem } from '@cascadia/commons/items/types/interface'
import type { InterfaceDetailTab } from '@/components/interfaces/InterfaceDetail'
import {
  INTERFACE_DETAIL_TABS,
  InterfaceDetail,
} from '@/components/interfaces/InterfaceDetail'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/query'
import { apiFetch } from '@/api/client'

// Version-context params + tab. useVersionContext reads and writes
// branch/tag/commit through the URL; validateSearch strips anything the
// schema does not name, so without these a context switch (or a
// revise-checkout navigation) silently lands back on main.
const interfaceDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z.enum(INTERFACE_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/interfaces/$id')({
  component: InterfaceDetailPage,
  validateSearch: interfaceDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      entityQuery<InterfaceItem>('interfaces', params.id, 'interface'),
    ),
})

function InterfaceDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: iface } = useQuery(
    entityQuery<InterfaceItem>('interfaces', id, 'interface'),
  )
  const search = Route.useSearch()

  if (!iface) return null

  const handleSave = async (updated: InterfaceItem) => {
    if (!iface.id) return
    await apiFetch(`/api/v1/interfaces/${iface.id}`, {
      method: 'PUT',
      body: JSON.stringify(updated),
    })
    showSuccess(
      'Interface updated',
      `${updated.itemNumber} has been updated successfully`,
    )
    await invalidate('interfaces')
  }

  const handleDelete = async () => {
    if (!iface.id) return
    await apiFetch(`/api/v1/interfaces/${iface.id}`, {
      method: 'DELETE',
    })
    showSuccess(
      'Interface deleted',
      `${iface.itemNumber} has been deleted`,
    )
    await invalidate('interfaces')
    navigate({ to: '/interfaces' })
  }

  const handleCancel = () => {
    navigate({ to: '/interfaces' })
  }

  const handleTabChange = (tab: InterfaceDetailTab) => {
    router.navigate({
      to: '/interfaces/$id',
      params: { id: iface.id ?? '' },
      search: {
        ...search,
        tab,
      },
      replace: true,
    })
  }

  return (
    <InterfaceDetail
      iface={iface}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      onTransitioned={() => void invalidate('interfaces')}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
