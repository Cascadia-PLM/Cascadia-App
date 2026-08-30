// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Tool } from '@/lib/items/types/tool'
import type { ToolDetailTab } from '@/components/tools/ToolDetail'
import { TOOL_DETAIL_TABS, ToolDetail } from '@/components/tools/ToolDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const toolDetailSearchSchema = z.object({
  tab: z.enum(TOOL_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/tools/$id')({
  component: ToolDetailPage,
  validateSearch: toolDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(entityQuery<Tool>('tools', params.id, 'tool')),
})

function ToolDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: tool } = useQuery(entityQuery<Tool>('tools', id, 'tool'))
  const search = Route.useSearch()

  if (!tool) return null

  const handleSave = async (updatedTool: Tool) => {
    if (!tool.id) return

    await apiFetch(`/api/v1/tools/${tool.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedTool),
    })

    showSuccess(
      'Tool updated',
      `${updatedTool.itemNumber} has been updated successfully`,
    )
    await invalidate('tools')
  }

  const handleDelete = async () => {
    if (!tool.id) return

    await apiFetch(`/api/v1/tools/${tool.id}`, {
      method: 'DELETE',
    })

    showSuccess('Tool deleted', `${tool.itemNumber} has been deleted`)
    await invalidate('tools')
    navigate({ to: '/tools' })
  }

  const handleCancel = () => {
    navigate({ to: '/tools' })
  }

  const handleTabChange = (tab: ToolDetailTab) => {
    router.navigate({
      to: '/tools/$id',
      params: { id: tool.id ?? '' },
      search: {
        tab,
      },
      replace: true,
    })
  }

  return (
    <ToolDetail
      tool={tool}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      onTransitioned={() => void invalidate('tools')}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
