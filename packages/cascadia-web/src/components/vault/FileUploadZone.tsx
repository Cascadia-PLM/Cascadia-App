// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useRef, useState } from 'react'
import { FileIcon, ImageIcon, Upload, X } from 'lucide-react'
import type { ChangeEvent, DragEvent } from 'react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * Image types accepted as an item thumbnail. Mirrors the server-side allowlist
 * in `src/lib/vault/utils/file-utils.ts` (SVG excluded - it is scriptable).
 */
const THUMBNAILABLE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/webp',
]

function canBeThumbnail(file: File): boolean {
  return THUMBNAILABLE_MIME_TYPES.includes(file.type.toLowerCase())
}

interface FileUploadZoneProps {
  itemId: string
  branchId?: string
  onUploadComplete?: (files: Array<any>) => void
  onUploadError?: (error: Error) => void
  maxSizeBytes?: number
  accept?: string
  className?: string
  /** Offer a "use as thumbnail" toggle on image files (default: true) */
  allowThumbnailSelection?: boolean
}

interface FileWithPreview {
  file: File
  id: string
  preview?: string
}

export function FileUploadZone({
  itemId,
  branchId,
  onUploadComplete,
  onUploadError,
  maxSizeBytes = 500 * 1024 * 1024, // 500MB
  accept,
  className,
  allowThumbnailSelection = true,
}: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<Array<FileWithPreview>>([])
  const [uploading, setUploading] = useState(false)
  // Local id of the file to designate as the item thumbnail (at most one)
  const [thumbnailId, setThumbnailId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = Array.from(e.dataTransfer.files)
    addFiles(files)
  }

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files)
      addFiles(files)
    }
  }

  const addFiles = (files: Array<File>) => {
    const newFiles: Array<FileWithPreview> = files.map((file) => {
      const id = crypto.randomUUID()

      // Create preview for images
      let preview: string | undefined
      if (file.type.startsWith('image/')) {
        preview = URL.createObjectURL(file)
      }

      return { file, id, preview }
    })

    setSelectedFiles((prev) => [...prev, ...newFiles])
  }

  const removeFile = (id: string) => {
    setSelectedFiles((prev) => {
      const file = prev.find((f) => f.id === id)
      if (file?.preview) {
        URL.revokeObjectURL(file.preview)
      }
      return prev.filter((f) => f.id !== id)
    })
    setThumbnailId((current) => (current === id ? null : current))
  }

  const toggleThumbnail = (id: string) => {
    setThumbnailId((current) => (current === id ? null : id))
  }

  const handleUpload = async () => {
    if (selectedFiles.length === 0) return

    setUploading(true)
    const formData = new FormData()

    // Include branch context for version-aware file uploads
    if (branchId) {
      formData.append('branchId', branchId)
    }

    selectedFiles.forEach((fileWithPreview, index) => {
      formData.append(`file_${index}`, fileWithPreview.file)
      if (fileWithPreview.id === thumbnailId) {
        formData.append(`file_${index}_isThumbnail`, 'true')
      }
    })

    try {
      const response = await fetch(`/api/v1/items/${itemId}/files/upload`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.details || error.error || 'Upload failed')
      }

      const result = await response.json()

      // Clear selected files
      selectedFiles.forEach((file) => {
        if (file.preview) {
          URL.revokeObjectURL(file.preview)
        }
      })
      setSelectedFiles([])
      setThumbnailId(null)

      onUploadComplete?.(result.files)
    } catch (error) {
      onUploadError?.(error as Error)
    } finally {
      setUploading(false)
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* Drop Zone */}
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'border-2 border-dashed rounded-lg p-8 text-center transition-colors',
          isDragging
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
            : 'border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600',
        )}
      >
        <Upload className="w-12 h-12 mx-auto mb-4 text-slate-400" />
        <p className="text-lg font-medium text-slate-900 dark:text-white mb-2">
          Drop files here or click to browse
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
          Maximum file size: {formatFileSize(maxSizeBytes)}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={accept}
          onChange={handleFileInput}
          className="hidden"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          Select Files
        </Button>
      </div>

      {/* Selected Files List */}
      {selectedFiles.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-slate-900 dark:text-white">
            Selected Files ({selectedFiles.length})
          </h3>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {selectedFiles.map((fileWithPreview) => (
              <div
                key={fileWithPreview.id}
                className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg"
              >
                {fileWithPreview.preview ? (
                  <img
                    src={fileWithPreview.preview}
                    alt={fileWithPreview.file.name}
                    className="w-10 h-10 object-cover rounded"
                  />
                ) : (
                  <FileIcon className="w-10 h-10 text-slate-400" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
                    {fileWithPreview.file.name}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {formatFileSize(fileWithPreview.file.size)}
                    {fileWithPreview.id === thumbnailId && (
                      <span className="ml-2 text-blue-600 dark:text-blue-400">
                        Will be used as thumbnail
                      </span>
                    )}
                  </p>
                </div>
                {allowThumbnailSelection &&
                  canBeThumbnail(fileWithPreview.file) && (
                    <Button
                      type="button"
                      variant={
                        fileWithPreview.id === thumbnailId ? 'default' : 'ghost'
                      }
                      size="icon"
                      onClick={() => toggleThumbnail(fileWithPreview.id)}
                      disabled={uploading}
                      aria-pressed={fileWithPreview.id === thumbnailId}
                      title={
                        fileWithPreview.id === thumbnailId
                          ? 'Do not use as thumbnail'
                          : 'Use as thumbnail'
                      }
                    >
                      <ImageIcon className="w-4 h-4" />
                    </Button>
                  )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeFile(fileWithPreview.id)}
                  disabled={uploading}
                  title="Remove"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>

          {/* Upload Button */}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                selectedFiles.forEach((file) => {
                  if (file.preview) {
                    URL.revokeObjectURL(file.preview)
                  }
                })
                setSelectedFiles([])
                setThumbnailId(null)
              }}
              disabled={uploading}
            >
              Clear All
            </Button>
            <Button type="button" onClick={handleUpload} disabled={uploading}>
              {uploading
                ? 'Uploading...'
                : `Upload ${selectedFiles.length} File${selectedFiles.length > 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
