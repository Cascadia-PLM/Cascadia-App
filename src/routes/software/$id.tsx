import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { Software } from '@/lib/items/types/software'
import type { Design } from '@/lib/types/design'
import { SoftwareDetail } from '@/components/software/SoftwareDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const softwareDetailSearchSchema = z.object({
  tab: z.enum(['details', 'source', 'history']).optional().default('details'),
})

export const Route = createFileRoute('/software/$id')({
  component: SoftwareDetailPage,
  validateSearch: softwareDetailSearchSchema,
  loader: async ({ params }) => {
    const [swResult, designsResult] = await Promise.all([
      apiFetch<{ data: { software: Software } }>(
        `/api/v1/software/${params.id}`,
      ),
      apiFetch<{ data: { designs: Array<Design> } }>('/api/v1/designs').catch(
        () => ({ data: { designs: [] as Array<Design> } }),
      ),
    ])
    return {
      software: swResult.data.software,
      designs: designsResult.data.designs,
    }
  },
})

function SoftwareDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const { software, designs } = Route.useLoaderData()
  const search = Route.useSearch()

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
    router.invalidate()
  }

  const handleDelete = async () => {
    if (!software.id) return

    await apiFetch(`/api/v1/software/${software.id}`, {
      method: 'DELETE',
    })

    showSuccess('Software deleted', `${software.itemNumber} has been deleted`)
    await router.invalidate()
    navigate({ to: '/software' })
  }

  const handleCancel = () => {
    navigate({ to: '/software' })
  }

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/software/$id',
      params: { id: software.id ?? '' },
      search: {
        tab: tab as 'details' | 'source' | 'history',
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
