// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Document } from '@/lib/items/types/document'
import type { ItemFilters } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { DocumentTable } from '@/components/documents/DocumentTable'
import { ImportButton } from '@/components/import/ImportButton'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { useServerDataGrid } from '@/lib/hooks/useServerDataGrid'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  designListQuery,
  gridParamsFromSearch,
  itemCountsQuery,
  itemGridQuery,
  itemListQuery,
  lifecycleByItemTypeQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'
import { LifecycleStateCards } from '@/components/items/LifecycleStateCards'

// The states behind the stat cards, counted in one request rather than one
// probe request each.
// Search schema for URL validation
const documentsSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_state: z.coerce.string().optional(),
  filter_docType: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  // Version context params
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

type DocumentsSearch = z.infer<typeof documentsSearchSchema>

// Shared by the loader and the component so both key on identical filters.
function documentFilters(search: DocumentsSearch): ItemFilters {
  return {
    itemType: 'Document',
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }
}

export const Route = createFileRoute('/documents/')({
  validateSearch: documentsSearchSchema,
  component: DocumentsListPage,
  // The whole search object, so the loader can derive the very same grid
  // params the component derives — same params, same query key, one fetch.
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const filters = documentFilters(deps)
    await Promise.all([
      queryClient.ensureQueryData(
        itemListQuery<Document>(filters, gridParamsFromSearch(deps)),
      ),
      (async () => {
        const lifecycle = await queryClient.ensureQueryData(
          lifecycleByItemTypeQuery('Document'),
        )
        await queryClient.ensureQueryData(
          itemCountsQuery(
            filters,
            lifecycle.states.map((state) => state.id),
          ),
        )
      })(),
      queryClient.ensureQueryData(designListQuery()),
    ])
  },
})

function DocumentsListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()

  const filters = documentFilters(searchParams)

  const { data: designs = [] } = useQuery(designListQuery())

  const {
    items: documents,
    total,
    dataGridProps,
  } = useServerDataGrid<Document>({
    query: itemGridQuery<Document>(filters),
  })

  // Get selected design from URL
  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d) => d.id === selectedDesignId)

  // Version context management
  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  // Navigate to detail page for editing
  const handleEditDocument = (document: Document) => {
    if (document.id) {
      navigate({ to: '/documents/$id', params: { id: document.id } })
    }
  }

  const handleDeleteDocument = (document: Document) => {
    if (!document.id) return

    confirm({
      title: 'Delete Document',
      description: `Are you sure you want to delete ${document.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/documents/${document.id}`, {
            method: 'DELETE',
          })

          showSuccess(
            'Document deleted',
            `${document.itemNumber} has been deleted`,
          )
          await invalidate('documents')
        } catch (error) {
          handleError(error, { title: 'Failed to delete document' })
        }
      },
    })
  }

  // Get context badge variant
  const getContextBadgeVariant = () => {
    switch (context.type) {
      case 'main':
        return 'default'
      case 'branch':
        return 'secondary'
      case 'tag':
        return 'outline'
      case 'commit':
        return 'outline'
      default:
        return 'default'
    }
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              Documents
            </h1>
            {selectedDesignId && (
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {contextLabel}
              </Badge>
            )}
          </div>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manage your document library
            {selectedDesign && (
              <span className="text-slate-500"> in {selectedDesign.name}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton
            itemType="Document"
            designId={selectedDesignId}
            onImportComplete={() => {
              void invalidate('documents')
            }}
          />
          <Link
            to="/documents/new"
            search={
              selectedDesignId ? { designId: selectedDesignId } : undefined
            }
            data-testid="create-document-link"
          >
            <Button
              disabled={!isEditable && context.type !== 'main'}
              data-testid="create-document-button"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Document
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats — one card per lifecycle state, from configuration */}
      <LifecycleStateCards
        itemType="Document"
        filters={filters}
        total={total}
        totalLabel="Total Documents"
      />

      {/* Documents Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Documents</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'document' : 'documents'} in the system
            {selectedDesign && context.type !== 'main' && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                (viewing {contextLabel})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentTable
            documents={documents}
            onEdit={handleEditDocument}
            onDelete={handleDeleteDocument}
            serverSidePagination={dataGridProps.serverSidePagination}
            totalRows={dataGridProps.totalRows}
            onPageChange={dataGridProps.onPageChange}
            isLoading={dataGridProps.isLoading}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
