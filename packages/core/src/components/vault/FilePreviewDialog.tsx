// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { PreviewableFile } from '@/components/vault/FilePreview'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { FilePreview } from '@/components/vault/FilePreview'

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes'
  const units = ['Bytes', 'KB', 'MB', 'GB']
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  )
  const value = Math.round((bytes / Math.pow(1024, exponent)) * 100) / 100
  return `${value} ${units[exponent]}`
}

interface FilePreviewDialogProps {
  /** The file to display, or `null` when the dialog is closed. */
  file: PreviewableFile | null
  onOpenChange: (open: boolean) => void
}

/**
 * Full-screen-ish preview of a single attached file. Opened from the file list
 * on any item type, so nothing here may assume the item is a Document.
 */
export function FilePreviewDialog({
  file,
  onOpenChange,
}: FilePreviewDialogProps) {
  return (
    <Dialog open={file !== null} onOpenChange={onOpenChange}>
      {/* `cn` is plain clsx, so an unprefixed `max-w-*` cannot beat the
          base `max-w-lg`; the `sm:` variant wins on specificity instead. */}
      <DialogContent className="grid-rows-[auto_1fr] overflow-hidden sm:h-[90vh] sm:max-w-6xl">
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate">
            {file?.originalFileName ?? 'Preview'}
          </DialogTitle>
          {file && (
            <DialogDescription>
              {formatFileSize(file.fileSize)}
            </DialogDescription>
          )}
        </DialogHeader>
        {file && <FilePreview file={file} className="min-h-0" />}
      </DialogContent>
    </Dialog>
  )
}
