import { useEffect, useState } from 'react'
import {
  Archive,
  Box,
  Download,
  Eye,
  FileIcon,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Lock,
  Music,
  Trash2,
  Unlock,
  Video,
} from 'lucide-react'
import type { DataGridColumn, Row } from '@/components/ui'
import { Badge, Button, DataGrid } from '@/components/ui'
import { cn } from '@/lib/utils'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface FileRecord {
  id: string
  itemId: string
  fileName: string
  originalFileName: string
  fileSize: number
  mimeType: string
  fileVersion: number
  isLatestVersion: boolean
  isCheckedOut: boolean
  checkedOutBy: string | null
  uploadedBy: string
  uploadedAt: string
  metadata?: any
  fileCategory?: string
  isPrimaryModel?: boolean
}

interface FileListProps {
  itemId: string
  branchId?: string
  mainBranchId?: string
  onFileDeleted?: (fileId: string) => void
  onFileCheckedOut?: (fileId: string) => void
  onFileCheckedIn?: (fileId: string) => void
  onViewCAD?: (fileId: string, fileName: string) => void
  className?: string
  isAdmin?: boolean
}

export function FileList({
  itemId,
  branchId,
  mainBranchId,
  onFileDeleted,
  onFileCheckedOut,
  onFileCheckedIn,
  onViewCAD,
  className,
  isAdmin = false,
}: FileListProps) {
  const { alert, confirm } = useAlertDialog()
  const [files, setFiles] = useState<Array<FileRecord>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadFiles()
  }, [itemId, branchId, mainBranchId])

  const loadFiles = async () => {
    try {
      setLoading(true)

      // Build URL with version context query params
      const url = new URL(`/api/v1/items/${itemId}/files`, window.location.origin)
      if (branchId) {
        url.searchParams.set('branchId', branchId)
      }
      if (mainBranchId) {
        url.searchParams.set('mainBranchId', mainBranchId)
      }

      const response = await fetch(url.toString())

      if (!response.ok) {
        throw new Error('Failed to load files')
      }

      const data = await response.json()
      setFiles(data.files || [])
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = async (file: FileRecord) => {
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
    } catch (err) {
      alert({
        title: 'Error',
        description: `Download failed: ${(err as Error).message}`,
        variant: 'destructive',
      })
    }
  }

  const handleDelete = (fileId: string) => {
    confirm({
      title: 'Delete File',
      description: 'Are you sure you want to delete this file?',
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          const response = await fetch(`/api/v1/files/${fileId}`, {
            method: 'DELETE',
          })

          if (!response.ok) {
            const errData = await response.json()
            throw new Error(errData.details || errData.error || 'Delete failed')
          }

          // Remove from list
          setFiles((prev) => prev.filter((f) => f.id !== fileId))
          onFileDeleted?.(fileId)
        } catch (err) {
          alert({
            title: 'Error',
            description: `Delete failed: ${(err as Error).message}`,
            variant: 'destructive',
          })
        }
      },
    })
  }

  const handleCheckOut = async (fileId: string) => {
    try {
      const response = await fetch(`/api/v1/files/${fileId}/checkout`, {
        method: 'POST',
      })

      if (!response.ok) {
        const errData = await response.json()
        throw new Error(errData.details || errData.error || 'Checkout failed')
      }

      // Reload files to get updated status
      await loadFiles()
      onFileCheckedOut?.(fileId)
    } catch (err) {
      alert({
        title: 'Error',
        description: `Checkout failed: ${(err as Error).message}`,
        variant: 'destructive',
      })
    }
  }

  const handleCheckIn = async (fileId: string) => {
    try {
      const response = await fetch(`/api/v1/files/${fileId}/checkin`, {
        method: 'POST',
      })

      if (!response.ok) {
        const errData = await response.json()
        throw new Error(errData.details || errData.error || 'Checkin failed')
      }

      // Reload files to get updated status
      await loadFiles()
      onFileCheckedIn?.(fileId)
    } catch (err) {
      alert({
        title: 'Error',
        description: `Checkin failed: ${(err as Error).message}`,
        variant: 'destructive',
      })
    }
  }

  const handleForceUnlock = (fileId: string) => {
    confirm({
      title: 'Force Unlock File',
      description:
        'This will release the checkout lock held by another user. Any unsaved changes by that user will be lost.',
      confirmText: 'Force Unlock',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          const response = await fetch(`/api/v1/files/${fileId}/force-unlock`, {
            method: 'POST',
          })

          if (!response.ok) {
            const errData = await response.json()
            throw new Error(
              errData.details || errData.error || 'Force unlock failed',
            )
          }

          await loadFiles()
        } catch (err) {
          alert({
            title: 'Error',
            description: `Force unlock failed: ${(err as Error).message}`,
            variant: 'destructive',
          })
        }
      },
    })
  }

  const getFileIcon = (mimeType: string, fileCategory?: string) => {
    // Check file category first (more specific)
    if (fileCategory === 'cad_model')
      return <Box className="w-4 h-4 text-blue-500" />
    if (fileCategory === 'drawing')
      return <FileText className="w-4 h-4 text-purple-500" />

    // Fall back to mime type detection
    if (mimeType.startsWith('image/')) return <ImageIcon className="w-4 h-4" />
    if (mimeType.startsWith('video/')) return <Video className="w-4 h-4" />
    if (mimeType.startsWith('audio/')) return <Music className="w-4 h-4" />
    if (mimeType.includes('pdf')) return <FileText className="w-4 h-4" />
    if (mimeType.includes('sheet') || mimeType.includes('excel'))
      return <FileSpreadsheet className="w-4 h-4" />
    if (mimeType.includes('zip') || mimeType.includes('tar'))
      return <Archive className="w-4 h-4" />
    return <FileIcon className="w-4 h-4" />
  }

  const getCategoryBadge = (
    category: string | undefined,
    isPrimary: boolean | undefined,
  ) => {
    if (category === undefined || category === 'reference') return null

    const categoryLabels: Record<
      string,
      {
        label: string
        variant:
          | 'default'
          | 'secondary'
          | 'success'
          | 'warning'
          | 'destructive'
          | 'outline'
      }
    > = {
      cad_model: { label: 'CAD Model', variant: 'default' },
      drawing: { label: 'Drawing', variant: 'secondary' },
      specification: { label: 'Spec', variant: 'outline' },
      analysis: { label: 'Analysis', variant: 'warning' },
    }

    if (!(category in categoryLabels)) return null
    const config = categoryLabels[category]

    return (
      <div className="flex items-center gap-1">
        <Badge variant={config.variant} className="text-xs">
          {config.label}
        </Badge>
        {isPrimary && (
          <Badge variant="success" className="text-xs">
            Primary
          </Badge>
        )}
      </div>
    )
  }

  const isViewableCAD = (file: FileRecord): boolean => {
    const ext = file.originalFileName.toLowerCase().split('.').pop()
    return ext === 'stl' || ext === 'obj'
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
  }

  if (loading) {
    return (
      <div className={cn('text-center py-8', className)}>
        <p className="text-slate-600 dark:text-slate-400">Loading files...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('text-center py-8', className)}>
        <p className="text-red-600 dark:text-red-400">Error: {error}</p>
        <Button onClick={loadFiles} className="mt-4">
          Retry
        </Button>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className={cn('text-center py-8', className)}>
        <FileIcon className="w-16 h-16 mx-auto mb-4 text-slate-300 dark:text-slate-600" />
        <p className="text-slate-600 dark:text-slate-400">
          No files attached to this item
        </p>
      </div>
    )
  }

  const columns: Array<DataGridColumn<FileRecord>> = [
    {
      id: 'icon',
      header: '',
      accessorFn: () => '', // Not used for display
      enableSorting: false,
      enableFiltering: false,
      cell: ({ row }) =>
        getFileIcon(row.original.mimeType, row.original.fileCategory),
    },
    {
      id: 'fileName',
      header: 'File Name',
      accessorKey: 'originalFileName',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search files...',
      cell: ({ row }) => {
        const file = row.original
        return (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <p className="font-medium text-slate-900 dark:text-white">
                {file.originalFileName}
              </p>
              {getCategoryBadge(file.fileCategory, file.isPrimaryModel)}
            </div>
            {file.metadata?.description && (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {file.metadata.description}
              </p>
            )}
          </div>
        )
      },
    },
    {
      id: 'fileSize',
      header: 'Size',
      accessorKey: 'fileSize',
      enableSorting: true,
      enableFiltering: true,
      filterType: 'range',
      filterPlaceholder: 'Any',
      cell: ({ getValue }) => {
        const bytes = getValue() as number
        return (
          <span className="text-slate-600 dark:text-slate-400">
            {formatFileSize(bytes)}
          </span>
        )
      },
    },
    {
      id: 'fileVersion',
      header: 'Version',
      accessorKey: 'fileVersion',
      enableSorting: true,
      enableFiltering: true,
      filterType: 'range',
      filterPlaceholder: 'Any',
      cell: ({ row }) => {
        const file = row.original
        return (
          <span className="text-slate-600 dark:text-slate-400">
            v{file.fileVersion}
            {file.isLatestVersion && (
              <span className="ml-2 text-xs text-green-600 dark:text-green-400">
                (latest)
              </span>
            )}
          </span>
        )
      },
    },
    {
      id: 'uploadedAt',
      header: 'Uploaded',
      accessorKey: 'uploadedAt',
      enableSorting: true,
      cell: ({ getValue }) => {
        const dateString = getValue() as string
        return (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {formatDate(dateString)}
          </p>
        )
      },
    },
    {
      id: 'isCheckedOut',
      header: 'Status',
      accessorKey: 'isCheckedOut',
      enableFiltering: true,
      filterType: 'select',
      filterOptions: [
        { label: 'Available', value: 'false' },
        { label: 'Checked Out', value: 'true' },
      ],
      cell: ({ getValue }) => {
        const isCheckedOut = getValue() as boolean
        if (isCheckedOut) {
          return (
            <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <Lock className="w-3 h-3" />
              <span className="text-xs">Checked Out</span>
            </div>
          )
        }
        return (
          <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
            <Unlock className="w-3 h-3" />
            <span className="text-xs">Available</span>
          </div>
        )
      },
    },
    {
      id: 'fileCategory',
      header: 'Category',
      accessorKey: 'fileCategory',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'CAD Model', value: 'cad_model' },
        { label: 'Drawing', value: 'drawing' },
        { label: 'Specification', value: 'specification' },
        { label: 'Analysis', value: 'analysis' },
        { label: 'Reference', value: 'reference' },
      ],
      // Hide column by default (already shown in fileName column)
      cell: () => null,
    },
  ]

  const renderRowActions = (row: Row<FileRecord>) => {
    const file = row.original
    return (
      <div className="flex justify-end gap-1">
        {isViewableCAD(file) && onViewCAD && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onViewCAD(file.id, file.originalFileName)}
            title="View in 3D"
          >
            <Eye className="w-4 h-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => handleDownload(file)}
          title="Download"
        >
          <Download className="w-4 h-4" />
        </Button>
        {!file.isCheckedOut ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleCheckOut(file.id)}
            title="Check Out"
          >
            <Lock className="w-4 h-4" />
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleCheckIn(file.id)}
              title="Check In"
            >
              <Unlock className="w-4 h-4" />
            </Button>
            {isAdmin && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleForceUnlock(file.id)}
                title="Force Unlock (Admin)"
                className="text-red-600 hover:text-red-700"
              >
                <Unlock className="w-4 h-4" />
              </Button>
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => handleDelete(file.id)}
          disabled={file.isCheckedOut}
          title="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    )
  }

  return (
    <div className={cn('', className)}>
      <DataGrid
        data={files}
        columns={columns}
        getRowId={(row) => row.id}
        enableRowActions={true}
        renderRowActions={renderRowActions}
        emptyMessage="No files attached to this item"
        emptyDescription="Upload files to get started"
      />
    </div>
  )
}
