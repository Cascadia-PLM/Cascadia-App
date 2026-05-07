import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { Tool } from '@/lib/items/types/tool'
import { ToolDetail } from '@/components/tools/ToolDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const toolDetailSearchSchema = z.object({
  tab: z.enum(['details', 'history']).optional().default('details'),
})

export const Route = createFileRoute('/tools/$id')({
  component: ToolDetailPage,
  validateSearch: toolDetailSearchSchema,
  loader: async ({ params }) => {
    try {
      const { data } = await apiFetch<{ data: { tool: Tool } }>(
        `/api/v1/tools/${params.id}`,
      )
      return { tool: data.tool }
    } catch (error) {
      console.error('Error loading tool:', error)
      throw error
    }
  },
})

function ToolDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const { tool } = Route.useLoaderData()
  const search = Route.useSearch()

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
    router.invalidate()
  }

  const handleDelete = async () => {
    if (!tool.id) return

    await apiFetch(`/api/v1/tools/${tool.id}`, {
      method: 'DELETE',
    })

    showSuccess('Tool deleted', `${tool.itemNumber} has been deleted`)
    await router.invalidate()
    navigate({ to: '/tools' })
  }

  const handleCancel = () => {
    navigate({ to: '/tools' })
  }

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/tools/$id',
      params: { id: tool.id ?? '' },
      search: {
        tab: tab as 'details' | 'history',
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
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
