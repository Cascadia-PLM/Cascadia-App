import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { ColumnFiltersState, SortingState } from '@tanstack/react-table'
import type { FileRecordWithItem } from '@/lib/vault/services/FileService'
import { PageContainer } from '@/components/layout'
import { FileTable } from '@/components/files/FileTable'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

// Search schema for URL validation
const filesSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_category: z.coerce.string().optional(),
  filter_status: z.coerce.string().optional(),
})

export const Route = createFileRoute('/files/')({
  validateSearch: filesSearchSchema,
  component: FilesListPage,
  loader: async () => {
    try {
      const result = await apiFetch<{
        data: { files: Array<FileRecordWithItem>; count: number }
      }>('/api/v1/files?limit=200')
      return {
        files: result.data.files,
      }
    } catch (error) {
      console.error('Error loading files:', error)
      return { files: [] as Array<FileRecordWithItem> }
    }
  },
})

function FilesListPage() {
  const router = useRouter()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { files: initialFiles } = Route.useLoaderData()
  const searchParams = Route.useSearch()
  const [files, setFiles] = useState<Array<FileRecordWithItem>>(initialFiles)

  // Parse URL params into initial grid state (read-only, no sync back)
  const defaultSorting: SortingState = searchParams.sortBy
    ? [{ id: searchParams.sortBy, desc: searchParams.sortOrder === 'desc' }]
    : [{ id: 'uploadedAt', desc: true }]

  const defaultColumnFilters: ColumnFiltersState = []
  if (searchParams.filter_category) {
    defaultColumnFilters.push({
      id: 'fileCategory',
      value: searchParams.filter_category,
    })
  }
  if (searchParams.filter_status) {
    defaultColumnFilters.push({
      id: 'isCheckedOut',
      value: searchParams.filter_status,
    })
  }

  const defaultGlobalFilter = searchParams.search || ''

  // Sync local state with loader data when it changes
  useEffect(() => {
    setFiles(initialFiles)
  }, [initialFiles])

  const handleDownload = async (file: FileRecordWithItem) => {
    try {
      const response = await fetch(`/api/v1/files/${file.id}/download`)

      if (!response.ok) {
        throw new Error('Download failed')
      }

      // Create a blob from the response
      const blob = await response.blob()

      // Create download link
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.originalFileName
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
    } catch (error) {
      handleError(error, { title: 'Failed to download file' })
    }
  }

  const handleDelete = (file: FileRecordWithItem) => {
    if (file.isCheckedOut) {
      handleError(new Error('Cannot delete a file that is checked out'), {
        title: 'Delete failed',
      })
      return
    }

    confirm({
      title: 'Delete File',
      description: `Are you sure you want to delete "${file.originalFileName}"? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/files/${file.id}`, {
            method: 'DELETE',
          })

          setFiles(files.filter((f) => f.id !== file.id))
          showSuccess(
            'File deleted',
            `${file.originalFileName} has been deleted`,
          )

          // Reload to get fresh data from server
          router.invalidate()
        } catch (error) {
          handleError(error, { title: 'Failed to delete file' })
        }
      },
    })
  }

  // Calculate stats
  const totalFiles = files.length
  const cadModels = files.filter((f) => f.fileCategory === 'cad_model').length
  const drawings = files.filter((f) => f.fileCategory === 'drawing').length
  const documents = files.filter(
    (f) =>
      f.fileCategory === 'specification' ||
      f.fileCategory === 'analysis' ||
      f.fileCategory === 'reference' ||
      f.fileCategory === 'other' ||
      !f.fileCategory,
  ).length

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Files
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Browse all files in the vault
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Files</CardDescription>
            <CardTitle className="text-3xl">{totalFiles}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>CAD Models</CardDescription>
            <CardTitle className="text-3xl">{cadModels}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Drawings</CardDescription>
            <CardTitle className="text-3xl">{drawings}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Documents</CardDescription>
            <CardTitle className="text-3xl">{documents}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Files Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Files</CardTitle>
          <CardDescription>
            {totalFiles} {totalFiles === 1 ? 'file' : 'files'} in the vault
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FileTable
            files={files}
            onDownload={handleDownload}
            onDelete={handleDelete}
            defaultSorting={defaultSorting}
            defaultColumnFilters={defaultColumnFilters}
            defaultGlobalFilter={defaultGlobalFilter}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
