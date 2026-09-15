// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { Document } from '@/lib/items/types/document'
import type { DocumentDetailTab } from '@/components/documents/DocumentDetail'
import {
  DOCUMENT_DETAIL_TABS,
  DocumentDetail,
} from '@/components/documents/DocumentDetail'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const documentDetailSearchSchema = z.object({
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  tab: z.enum(DOCUMENT_DETAIL_TABS).optional().default('details'),
})

export const Route = createFileRoute('/documents/$id')({
  component: DocumentDetailPage,
  validateSearch: documentDetailSearchSchema,
  loader: ({ context: { queryClient }, params }) =>
    queryClient.ensureQueryData(
      entityQuery<Document>('documents', params.id, 'document'),
    ),
})

function DocumentDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { id } = Route.useParams()
  const { data: document } = useQuery(
    entityQuery<Document>('documents', id, 'document'),
  )
  const search = Route.useSearch()

  if (!document) return null

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
    await invalidate('documents')
  }

  const handleDelete = async () => {
    if (!document.id) return

    await apiFetch(`/api/v1/documents/${document.id}`, {
      method: 'DELETE',
    })

    showSuccess('Document deleted', `${document.itemNumber} has been deleted`)
    await invalidate('documents')
    navigate({ to: '/documents' })
  }

  const handleCancel = () => {
    navigate({ to: '/documents' })
  }

  const handleTabChange = (tab: DocumentDetailTab) => {
    router.navigate({
      to: '/documents/$id',
      params: { id: document.id ?? '' },
      search: {
        ...search,
        tab,
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
