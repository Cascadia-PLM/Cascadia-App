import { useRef, useState } from 'react'
import { FileIcon, Upload, X } from 'lucide-react'
import type { ChangeEvent, DragEvent } from 'react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

interface FileUploadZoneProps {
  itemId: string
  branchId?: string
  onUploadComplete?: (files: Array<any>) => void
  onUploadError?: (error: Error) => void
  maxSizeBytes?: number
  accept?: string
  className?: string
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
}: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<Array<FileWithPreview>>([])
  const [uploading, setUploading] = useState(false)
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
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeFile(fileWithPreview.id)}
                  disabled={uploading}
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
