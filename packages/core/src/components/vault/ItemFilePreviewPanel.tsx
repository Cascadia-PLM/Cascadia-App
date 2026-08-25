// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileSearch } from 'lucide-react'
import type { FileRecord } from '@/components/vault/FileList'
import { Card, CardContent } from '@/components/ui'
import { cn } from '@/lib/utils'
import { itemFilesQuery } from '@/lib/query/options/item-files'
import { authSessionQuery } from '@/lib/query'
import { FilePreview } from '@/components/vault/FilePreview'
import { useFileMarkup } from '@/components/vault/useFileMarkup'
import { isPreviewable, previewKindFor } from '@/lib/vault/preview'

interface PreviewContext {
  branchId?: string
  mainBranchId?: string
}

/**
 * An item's previewable attachments, for callers that need to know whether
 * there is anything to show before they render a tab for it.
 *
 * Shares `FileList`'s query — same item, same version context — so asking
 * costs no extra request. Mirrors `useItemImages`, which answers the same
 * question for the gallery.
 */
export function useItemPreviewableFiles(
  itemId: string | undefined,
  context: PreviewContext,
) {
  const { data: files = [], isLoading } = useQuery({
    ...itemFilesQuery<FileRecord>(itemId ?? '', context),
    enabled: Boolean(itemId),
  })

  const previewable = files.filter((file) =>
    isPreviewable(file.originalFileName, file.fileSize),
  )

  // Images are previewable *and* gallery-able. `documents` excludes them so a
  // caller that already offers a gallery can ask "is there anything the
  // gallery would not already show?" and avoid two tabs doing one job. SVG is
  // a separate kind and stays in: the gallery does not render it.
  const documents = previewable.filter(
    (file) => previewKindFor(file.originalFileName) !== 'image',
  )

  return { previewable, documents, isLoading }
}

interface ItemFilePreviewPanelProps {
  itemId: string
  branchId?: string
  mainBranchId?: string
  /**
   * Whether this user currently holds the item's edit lock. Markup is an edit
   * to the engineering record, so the viewer is read-only without it — the
   * server enforces the same rule, this only decides whether to offer the
   * tools.
   */
  canAnnotate?: boolean
  className?: string
}

/**
 * Reads an item's attached documents without leaving Cascadia.
 *
 * Item-type agnostic on purpose: it only ever asks the vault what is attached
 * to an item id, so a Document, a Part, a Test Case, or any item type added
 * later gets the same panel by rendering it.
 */
export function ItemFilePreviewPanel({
  itemId,
  branchId,
  mainBranchId,
  canAnnotate = false,
  className,
}: ItemFilePreviewPanelProps) {
  const { previewable, isLoading } = useItemPreviewableFiles(itemId, {
    branchId,
    mainBranchId,
  })

  const { data: session } = useQuery(authSessionQuery())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // The selection is resolved rather than stored: an explicit pick wins, then
  // the item's primary file, then the first PDF — the document itself is
  // almost always what someone opened this tab to read, not a stray README
  // that happens to sort earlier. Deleting the selected file therefore falls
  // back on its own instead of stranding the panel.
  const selected =
    previewable.find((file) => file.id === selectedId) ??
    previewable.find((file) => file.isPrimaryModel) ??
    previewable.find(
      (file) => previewKindFor(file.originalFileName) === 'pdf',
    ) ??
    previewable[0]

  const { markup, markupDialog } = useFileMarkup({
    fileId: selected?.id ?? '',
    canAnnotate,
    disabledReason: 'Check out this item to mark it up',
    currentUserId: session?.user?.id,
  })

  if (isLoading) {
    return (
      <Card className={className}>
        <CardContent className="py-12 text-center text-slate-600 dark:text-slate-400">
          Loading files...
        </CardContent>
      </Card>
    )
  }

  if (previewable.length === 0) {
    return (
      <Card className={className}>
        <CardContent className="py-12 text-center">
          <FileSearch className="mx-auto mb-4 h-12 w-12 text-slate-300 dark:text-slate-600" />
          <p className="text-slate-600 dark:text-slate-400">
            No previewable files attached
          </p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-500">
            Attach a PDF, drawing, image, or text file to read it here.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className={cn('space-y-3', className)}>
      {previewable.length > 1 && (
        <div className="flex items-center gap-2">
          <label
            htmlFor="preview-file-select"
            className="text-sm text-slate-600 dark:text-slate-400"
          >
            File
          </label>
          <select
            id="preview-file-select"
            value={selected?.id ?? ''}
            onChange={(event) => setSelectedId(event.target.value)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            {previewable.map((file) => (
              <option key={file.id} value={file.id}>
                {file.originalFileName}
              </option>
            ))}
          </select>
        </div>
      )}
      {selected && (
        <FilePreview file={selected} markup={markup} className="h-[75vh]" />
      )}
      {markupDialog}
    </div>
  )
}
