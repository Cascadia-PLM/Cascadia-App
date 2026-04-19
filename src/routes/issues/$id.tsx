import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { Issue } from '@/lib/items/types/issue'
import type { Design } from '@/lib/types/design'
import { IssueDetail } from '@/components/issues/IssueDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const issueDetailSearchSchema = z.object({
  tab: z.enum(['details', 'history']).optional().default('details'),
})

export const Route = createFileRoute('/issues/$id')({
  component: IssueDetailPage,
  validateSearch: issueDetailSearchSchema,
  loader: async ({ params }) => {
    try {
      const [issueResult, designsResult] = await Promise.all([
        apiFetch<{ data: { issue: Issue } }>(`/api/issues/${params.id}`),
        apiFetch<{ data: { designs: Array<Design> } }>('/api/designs'),
      ])
      return {
        issue: issueResult.data.issue,
        designs: designsResult.data.designs,
      }
    } catch (error) {
      console.error('Error loading issue:', error)
      throw error
    }
  },
})

function IssueDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const { issue, designs } = Route.useLoaderData()
  const search = Route.useSearch()

  const handleSave = async (updatedIssue: Issue) => {
    if (!issue.id) return

    await apiFetch(`/api/issues/${issue.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedIssue),
    })

    showSuccess(
      'Issue updated',
      `${updatedIssue.itemNumber} has been updated successfully`,
    )
    router.invalidate()
  }

  const handleDelete = async () => {
    if (!issue.id) return

    await apiFetch(`/api/issues/${issue.id}`, {
      method: 'DELETE',
    })

    showSuccess('Issue deleted', `${issue.itemNumber} has been deleted`)
    await router.invalidate()
    navigate({ to: '/issues' })
  }

  const handleCancel = () => {
    navigate({ to: '/issues' })
  }

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/issues/$id',
      params: { id: issue.id ?? '' },
      search: {
        tab: tab as 'details' | 'history',
      },
      replace: true,
    })
  }

  return (
    <IssueDetail
      issue={issue}
      designs={designs}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
