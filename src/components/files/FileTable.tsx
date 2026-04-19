import { Link } from '@tanstack/react-router'
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
  MoreVertical,
  Music,
  Trash2,
  Unlock,
  Video,
} from 'lucide-react'
import type {
  ColumnFiltersState,
  Row,
  SortingState,
} from '@tanstack/react-table'
import type { DataGridColumn } from '@/components/ui'
import type { FileRecordWithItem } from '@/lib/vault/services/FileService'
import { Badge, DataGrid } from '@/components/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/ContextMenu'
import { Button } from '@/components/ui/Button'
import { formatFileSize } from '@/lib/vault/utils/file-utils'

// Re-export for backwards compatibility
export type VaultFileRecord = FileRecordWithItem

interface FileTableProps {
  files: Array<VaultFileRecord>
  onDownload?: (file: VaultFileRecord) => void
  onDelete?: (file: VaultFileRecord) => void
  onViewCAD?: (file: VaultFileRecord) => void
  defaultSorting?: SortingState
  defaultColumnFilters?: ColumnFiltersState
  defaultGlobalFilter?: string
}

export function FileTable({
  files,
  onDownload,
  onDelete,
  onViewCAD,
  defaultSorting,
  defaultColumnFilters,
  defaultGlobalFilter,
}: FileTableProps) {
  const getFileIcon = (mimeType: string, fileCategory?: string | null) => {
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
    category: string | null | undefined,
    isPrimary: boolean | undefined,
  ) => {
    if (
      category === undefined ||
      category === null ||
      category === 'reference' ||
      category === 'other'
    )
      return null

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

  const getItemTypeRoute = (itemType: string): string => {
    switch (itemType) {
      case 'Part':
        return '/parts'
      case 'Document':
        return '/documents'
      case 'ChangeOrder':
        return '/change-orders'
      case 'Requirement':
        return '/requirements'
      case 'Task':
        return '/tasks'
      default:
        return '/parts'
    }
  }

  const isViewableCAD = (file: VaultFileRecord): boolean => {
    const ext = file.originalFileName.toLowerCase().split('.').pop()
    return ext === 'stl' || ext === 'obj'
  }

  const formatDate = (dateValue: Date | string): string => {
    const date = typeof dateValue === 'string' ? new Date(dateValue) : dateValue
    return (
      date.toLocaleDateString() +
      ' ' +
      date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    )
  }

  const columns: Array<DataGridColumn<VaultFileRecord>> = [
    {
      id: 'icon',
      header: '',
      accessorFn: () => '',
      enableSorting: false,
      enableFiltering: false,
      meta: { width: '40px' },
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
              <span className="font-medium text-slate-900 dark:text-white">
                {file.originalFileName}
              </span>
              {getCategoryBadge(file.fileCategory, file.isPrimaryModel)}
            </div>
          </div>
        )
      },
    },
    {
      id: 'item',
      header: 'Item',
      accessorFn: (row) => row.item.itemNumber,
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search items...',
      cell: ({ row }) => {
        const file = row.original
        const route = getItemTypeRoute(file.item.itemType)
        return (
          <div className="space-y-0.5">
            <Link
              to={`${route}/${file.item.id}` as any}
              className="text-cyan-600 dark:text-cyan-400 hover:underline font-medium"
            >
              {file.item.itemNumber}
            </Link>
            {file.item.name && (
              <p
                className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[200px]"
                title={file.item.name}
              >
                {file.item.name}
              </p>
            )}
          </div>
        )
      },
    },
    {
      id: 'itemType',
      header: 'Type',
      accessorFn: (row) => row.item.itemType,
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Part', value: 'Part' },
        { label: 'Document', value: 'Document' },
        { label: 'Change Order', value: 'ChangeOrder' },
        { label: 'Requirement', value: 'Requirement' },
        { label: 'Task', value: 'Task' },
      ],
      cell: ({ row }) => {
        const itemType = row.original.item.itemType
        const variantMap: Record<string, 'default' | 'secondary' | 'outline'> =
          {
            Part: 'default',
            Document: 'secondary',
            ChangeOrder: 'outline',
            Requirement: 'secondary',
            Task: 'outline',
          }
        return (
          <Badge
            variant={variantMap[itemType] ?? 'default'}
            className="text-xs"
          >
            {itemType === 'ChangeOrder' ? 'Change Order' : itemType}
          </Badge>
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
      meta: { align: 'right' as const },
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
      cell: ({ row }) => {
        const file = row.original
        return (
          <span className="text-slate-600 dark:text-slate-400">
            v{file.fileVersion}
            {file.isLatestVersion && (
              <span className="ml-1 text-xs text-green-600 dark:text-green-400">
                (latest)
              </span>
            )}
          </span>
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
      id: 'uploadedAt',
      header: 'Uploaded',
      accessorKey: 'uploadedAt',
      enableSorting: true,
      cell: ({ row }) => {
        const file = row.original
        return (
          <div className="space-y-0.5">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {formatDate(file.uploadedAt)}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-500">
              by {file.uploader.name || file.uploader.email}
            </p>
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
        { label: 'Other', value: 'other' },
      ],
      // Hide column by default (already shown in fileName column)
      cell: () => null,
    },
  ]

  const renderRowActions = (row: Row<VaultFileRecord>) => {
    const file = row.original
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isViewableCAD(file) && onViewCAD && (
            <DropdownMenuItem onClick={() => onViewCAD(file)}>
              <Eye className="mr-2 h-4 w-4" />
              View in 3D
            </DropdownMenuItem>
          )}
          {onDownload && (
            <DropdownMenuItem onClick={() => onDownload(file)}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link
              to={
                `${getItemTypeRoute(file.item.itemType)}/${file.item.id}` as any
              }
            >
              <FileIcon className="mr-2 h-4 w-4" />
              View Item
            </Link>
          </DropdownMenuItem>
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(file)}
                disabled={file.isCheckedOut}
                className="text-red-600 dark:text-red-400"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const renderContextMenuItems = (row: Row<VaultFileRecord>) => {
    const file = row.original
    return (
      <>
        {isViewableCAD(file) && onViewCAD && (
          <ContextMenuItem onClick={() => onViewCAD(file)}>
            <Eye className="mr-2 h-4 w-4" />
            View in 3D
          </ContextMenuItem>
        )}
        {onDownload && (
          <ContextMenuItem onClick={() => onDownload(file)}>
            <Download className="mr-2 h-4 w-4" />
            Download
          </ContextMenuItem>
        )}
        <ContextMenuItem asChild>
          <Link
            to={
              `${getItemTypeRoute(file.item.itemType)}/${file.item.id}` as any
            }
          >
            <FileIcon className="mr-2 h-4 w-4" />
            View Item
          </Link>
        </ContextMenuItem>
        {onDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => onDelete(file)}
              disabled={file.isCheckedOut}
              className="text-red-600 focus:text-red-600"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </ContextMenuItem>
          </>
        )}
      </>
    )
  }

  return (
    <DataGrid
      data={files}
      columns={columns}
      getRowId={(row) => row.id}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      renderContextMenuItems={renderContextMenuItems}
      defaultSorting={defaultSorting}
      defaultColumnFilters={defaultColumnFilters}
      defaultGlobalFilter={defaultGlobalFilter}
      emptyMessage="No files found"
      emptyDescription="Files will appear here when uploaded to items"
      exportFilename="files"
    />
  )
}
