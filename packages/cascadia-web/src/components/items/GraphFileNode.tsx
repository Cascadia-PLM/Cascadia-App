// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import {
  Archive,
  Box,
  Download,
  FileIcon,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Music,
  Video,
} from 'lucide-react'
import { formatFileSize } from '@/lib/vault/utils/file-utils'
import {
  FILE_CATEGORY_DEFINITIONS,
  isFileCategory,
} from '@/lib/vault/file-categories'

interface GraphFileNodeProps {
  data: {
    fileId: string
    fileName: string
    fileSize: number
    mimeType: string
    fileCategory: string | null
    isPrimaryModel: boolean
    fileVersion: number
    level: number
  }
}

function FileTypeIcon({
  mimeType,
  fileCategory,
}: {
  mimeType: string
  fileCategory: string | null
}) {
  // Category first (more specific), then mime type — mirrors FileTable
  if (fileCategory === 'cad_model')
    return <Box className="h-4 w-4 text-blue-500" />
  if (fileCategory === 'drawing')
    return <FileText className="h-4 w-4 text-purple-500" />
  if (mimeType.startsWith('image/')) return <ImageIcon className="h-4 w-4" />
  if (mimeType.startsWith('video/')) return <Video className="h-4 w-4" />
  if (mimeType.startsWith('audio/')) return <Music className="h-4 w-4" />
  if (mimeType.includes('pdf')) return <FileText className="h-4 w-4" />
  if (mimeType.includes('sheet') || mimeType.includes('excel'))
    return <FileSpreadsheet className="h-4 w-4" />
  if (mimeType.includes('zip') || mimeType.includes('tar'))
    return <Archive className="h-4 w-4" />
  return <FileIcon className="h-4 w-4" />
}

/**
 * Leaf node for a vault file attached to an item in the relationship graph.
 * Files are not items: no detail route, no expand/collapse — just identity,
 * category, and a download affordance.
 */
export const GraphFileNode = memo(({ data }: GraphFileNodeProps) => {
  const {
    fileId,
    fileName,
    fileSize,
    mimeType,
    fileCategory,
    isPrimaryModel,
    fileVersion,
  } = data

  const categoryDefinition = isFileCategory(fileCategory)
    ? FILE_CATEGORY_DEFINITIONS[fileCategory]
    : undefined
  const categoryLabel = categoryDefinition?.badged
    ? categoryDefinition.badgeLabel
    : undefined

  return (
    <div
      className="
        px-4 py-3 rounded-lg border-2 border-dashed border-sky-400 dark:border-sky-600
        bg-sky-50 dark:bg-sky-950 shadow-md min-w-[200px] max-w-[280px]
        transition-all hover:shadow-lg
      "
    >
      {/* Edges arrive from the owning item; files have no outgoing edges */}
      <Handle type="target" position={Position.Top} className="!bg-sky-400" />
      <Handle type="target" position={Position.Left} className="!bg-sky-400" />

      {/* File header */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0 text-slate-700 dark:text-slate-300">
          <FileTypeIcon mimeType={mimeType} fileCategory={fileCategory} />
          <span
            className="font-semibold text-sm text-slate-900 dark:text-white truncate"
            title={fileName}
          >
            {fileName}
          </span>
        </div>
        <a
          href={`/api/v1/files/${fileId}/download`}
          download
          onClick={(e) => e.stopPropagation()}
          className="
            nopan nodrag flex-shrink-0 p-1 rounded
            text-slate-500 dark:text-slate-400
            hover:bg-sky-100 dark:hover:bg-sky-900
            hover:text-sky-600 dark:hover:text-sky-400
            transition-colors
          "
          title="Download file"
        >
          <Download className="h-4 w-4" />
        </a>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1">
        <span className="text-xs px-2 py-0.5 rounded bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300">
          File
        </span>
        {categoryLabel && (
          <span className="text-xs px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
            {categoryLabel}
          </span>
        )}
        {isPrimaryModel && (
          <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
            Primary
          </span>
        )}
      </div>

      {/* Size and version */}
      <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        {formatFileSize(fileSize)} · v{fileVersion}
      </div>
    </div>
  )
})

GraphFileNode.displayName = 'GraphFileNode'
