import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { Requirement } from '@/lib/items/types/requirement'
import { RequirementDetail } from '@/components/requirements/RequirementDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
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
  loader: async ({ params }) => {
    try {
      const result = await apiFetch<{ data: { requirement: Requirement } }>(
        `/api/v1/requirements/${params.id}`,
      )
      return { requirement: result.data.requirement }
    } catch (error) {
      console.error('Error loading requirement:', error)
      throw error
    }
  },
})

function RequirementDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const { requirement } = Route.useLoaderData()
  const search = Route.useSearch()

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
    router.invalidate()
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
    await router.invalidate()
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
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
