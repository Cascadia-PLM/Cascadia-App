// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { ColumnFiltersState, SortingState } from '@tanstack/react-table'
import type { FileRecordWithItem } from '@/lib/vault/services/FileService'
import type { FileCategory } from '@/lib/vault/file-categories'
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
import { fileListQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'
import { fileCategoryLabel } from '@/lib/vault/file-categories'

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
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(fileListQuery()),
})

function FilesListPage() {
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const { data: files = [] } = useQuery(fileListQuery())
  const searchParams = Route.useSearch()

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

  const handleSetCategory = async (
    file: FileRecordWithItem,
    category: FileCategory | null,
  ) => {
    try {
      await apiFetch(`/api/v1/files/${file.id}/category`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      })

      showSuccess(
        'Category updated',
        category === null
          ? `${file.originalFileName} is back to its auto-detected category`
          : `${file.originalFileName} is now tagged ${fileCategoryLabel(category)}`,
      )

      await invalidate('files')
    } catch (error) {
      handleError(error, { title: 'Failed to update category' })
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

          showSuccess(
            'File deleted',
            `${file.originalFileName} has been deleted`,
          )

          await invalidate('files')
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
            onSetCategory={handleSetCategory}
            defaultSorting={defaultSorting}
            defaultColumnFilters={defaultColumnFilters}
            defaultGlobalFilter={defaultGlobalFilter}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
