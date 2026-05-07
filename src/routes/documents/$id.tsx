import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { Document } from '@/lib/items/types/document'
import { DocumentDetail } from '@/components/documents/DocumentDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

const documentDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z
    .enum(['details', 'relationships', 'history'])
    .optional()
    .default('details'),
})

export const Route = createFileRoute('/documents/$id')({
  component: DocumentDetailPage,
  validateSearch: documentDetailSearchSchema,
  loader: async ({ params }) => {
    try {
      const result = await apiFetch<{ data: { document: Document } }>(
        `/api/v1/documents/${params.id}`,
      )
      return { document: result.data.document }
    } catch (error) {
      console.error('Error loading document:', error)
      throw error
    }
  },
})

function DocumentDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const { document } = Route.useLoaderData()
  const search = Route.useSearch()

  const handleSave = async (updatedDocument: Document) => {
    if (!document.id) return

    await apiFetch(`/api/v1/documents/${document.id}`, {
      method: 'PUT',
      body: JSON.stringify(updatedDocument),
    })

    showSuccess(
      'Document updated',
      `${updatedDocument.itemNumber} has been updated successfully`,
    )
    router.invalidate()
  }

  const handleDelete = async () => {
    if (!document.id) return

    await apiFetch(`/api/v1/documents/${document.id}`, {
      method: 'DELETE',
    })

    showSuccess('Document deleted', `${document.itemNumber} has been deleted`)
    await router.invalidate()
    navigate({ to: '/documents' })
  }

  const handleCancel = () => {
    navigate({ to: '/documents' })
  }

  const handleTabChange = (tab: string) => {
    router.navigate({
      to: '/documents/$id',
      params: { id: document.id ?? '' },
      search: {
        ...search,
        tab: tab as 'details' | 'relationships' | 'history',
      },
      replace: true,
    })
  }

  return (
    <DocumentDetail
      document={document}
      onSave={handleSave}
      onDelete={handleDelete}
      onCancel={handleCancel}
      activeTab={search.tab}
      onTabChange={handleTabChange}
    />
  )
}
