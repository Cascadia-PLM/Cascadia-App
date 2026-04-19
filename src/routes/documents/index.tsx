import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { Document } from '@/lib/items/types/document'
import type { Design } from '@/lib/types/design'
import { PageContainer } from '@/components/layout'
import { DocumentTable } from '@/components/documents/DocumentTable'
import { ImportButton } from '@/components/import/ImportButton'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
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
import { apiFetch } from '@/lib/api/client'

// State counts interface matching server response
interface StateCounts {
  draft: number
  inReview: number
  released: number
}

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

export const Route = createFileRoute('/documents/')({
  validateSearch: documentsSearchSchema,
  component: DocumentsListPage,
  // Make loader depend on search params so it re-runs when they change
  loaderDeps: ({ search }) => ({
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }),
  loader: async ({ deps }) => {
    try {
      const { programId, designId, branch, tag, commit } = deps

      // Build query params for items API
      const params = new URLSearchParams({
        itemType: 'Document',
        limit: '10',
        offset: '0',
      })
      if (programId) params.set('programId', programId)
      if (designId) params.set('designId', designId)
      if (branch) params.set('branch', branch)
      if (tag) params.set('tag', tag)
      if (commit) params.set('commit', commit)

      // Build count params (mirror filters but not pagination)
      const countParams = new URLSearchParams({
        itemType: 'Document',
        limit: '1',
      })
      if (programId) countParams.set('programId', programId)
      if (designId) countParams.set('designId', designId)
      if (branch) countParams.set('branch', branch)
      if (tag) countParams.set('tag', tag)
      if (commit) countParams.set('commit', commit)

      // Fetch first page of documents, designs, and state counts in parallel
      const [
        documentsResult,
        designsResult,
        draftCount,
        inReviewCount,
        releasedCount,
      ] = await Promise.all([
        apiFetch<{ data: { items: Array<Document>; total: number } }>(
          `/api/items?${params}`,
        ),
        apiFetch<{ data: { designs: Array<Design> } }>('/api/designs'),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=Draft`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=InReview`,
        ).catch(() => ({ data: { total: 0 } })),
        apiFetch<{ data: { total: number } }>(
          `/api/items?${countParams}&state=Released`,
        ).catch(() => ({ data: { total: 0 } })),
      ])

      return {
        documents: documentsResult.data.items,
        total: documentsResult.data.total,
        counts: {
          draft: draftCount.data.total,
          inReview: inReviewCount.data.total,
          released: releasedCount.data.total,
        } as StateCounts,
        designs: designsResult.data.designs,
      }
    } catch (error) {
      console.error('Error loading documents:', error)
      return {
        documents: [] as Array<Document>,
        total: 0,
        counts: { draft: 0, inReview: 0, released: 0 } as StateCounts,
        designs: [] as Array<Design>,
      }
    }
  },
})

function DocumentsListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const {
    documents: initialDocuments,
    total: initialTotal,
    counts: initialCounts,
    designs,
  } = Route.useLoaderData()
  const searchParams = Route.useSearch()

  // State for server-side pagination
  const [documents, setDocuments] = useState<Array<Document>>(initialDocuments)
  const [total, setTotal] = useState<number>(initialTotal)
  const [counts, setCounts] = useState<StateCounts>(initialCounts)
  const [isLoading, setIsLoading] = useState(false)

  // Get selected design from URL
  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d: Design) => d.id === selectedDesignId)

  // Version context management
  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  // Sync local state with loader data when it changes (e.g., after navigation back from detail page)
  useEffect(() => {
    setDocuments(initialDocuments)
    setTotal(initialTotal)
    setCounts(initialCounts)
  }, [initialDocuments, initialTotal, initialCounts])

  // Handle page change for server-side pagination
  const handlePageChange = useCallback(
    async (page: number, pageSize: number) => {
      setIsLoading(true)
      try {
        const qp = new URLSearchParams({ itemType: 'Document' })
        qp.set('limit', String(pageSize))
        qp.set('offset', String((page - 1) * pageSize))
        if (selectedDesignId) qp.set('designId', selectedDesignId)
        if (searchParams.branch) qp.set('branch', searchParams.branch)
        if (searchParams.tag) qp.set('tag', searchParams.tag)
        if (searchParams.commit) qp.set('commit', searchParams.commit)

        const result = await apiFetch<{
          data: { items: Array<Document>; total: number }
        }>(`/api/items?${qp}`)
        setDocuments(result.data.items)
        setTotal(result.data.total)
      } catch (error) {
        handleError(error, { title: 'Failed to load documents' })
      } finally {
        setIsLoading(false)
      }
    },
    [
      selectedDesignId,
      searchParams.programId,
      searchParams.branch,
      searchParams.tag,
      searchParams.commit,
      handleError,
    ],
  )

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
          await apiFetch(`/api/documents/${document.id}`, {
            method: 'DELETE',
          })

          setDocuments(documents.filter((d) => d.id !== document.id))
          showSuccess(
            'Document deleted',
            `${document.itemNumber} has been deleted`,
          )

          // Reload to get fresh data from server
          router.invalidate()
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
            onImportComplete={() => router.invalidate()}
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

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Documents</CardDescription>
            <CardTitle className="text-3xl">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Draft</CardDescription>
            <CardTitle className="text-3xl">{counts.draft}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">{counts.inReview}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Released</CardDescription>
            <CardTitle className="text-3xl">{counts.released}</CardTitle>
          </CardHeader>
        </Card>
      </div>

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
            serverSidePagination
            totalRows={total}
            onPageChange={handlePageChange}
            isLoading={isLoading}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
