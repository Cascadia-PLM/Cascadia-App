import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { Part } from '@/lib/items/types/part'
import { PartDetail } from '@/components/parts/PartDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

// Search schema for version context URL params and tab
const partDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z
    .enum(['details', 'relationships', 'work-instructions', 'history'])
    .optional()
    .default('details'),
})

export const Route = createFileRoute('/parts/$id')({
  component: PartDetailPage,
  validateSearch: partDetailSearchSchema,
  loader: async ({ params }) => {
    try {
      const result = await apiFetch<{ data: { part: Part } }>(
        `/api/parts/${params.id}`,
      )
      return { part: result.data.part }
    } catch (error) {
      console.error('Error loading part:', error)
      throw error
    }
  },
})

function PartDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const { part } = Route.useLoaderData()
  const search = Route.useSearch()

  const handleSave = async (updatedPart: Part) => {
    if (!part.id) return

    await apiFetch(`/api/parts/${part.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedPart),
    })

    showSuccess(
      'Part updated',
      `${updatedPart.itemNumber} has been updated successfully`,
    )
    router.invalidate()
  }

  const handleDelete = async () => {
    if (!part.id) return

    await apiFetch(`/api/parts/${part.id}`, {
      method: 'DELETE',
    })

    showSuccess('Part deleted', `${part.itemNumber} has been deleted`)
    await router.invalidate()
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
          | 'relationships'
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
