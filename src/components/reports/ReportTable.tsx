import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Eye, EyeOff, Pencil, Play, Trash2 } from 'lucide-react'
import type { Report } from '@/lib/reports/types'
import type { DataGridColumn, Row } from '@/components/ui'
import { Badge, Button, DataGrid } from '@/components/ui'

interface ReportTableProps {
  reports: Array<Report>
  onDelete?: (report: Report) => void
}

export function ReportTable({ reports, onDelete }: ReportTableProps) {
  const columns: Array<DataGridColumn<Report>> = [
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search reports...',
      cell: ({ row }) =>
        row.original.id ? (
          <Link
            to="/reports/$id/view"
            params={{ id: row.original.id }}
            className="font-medium text-sky-600 hover:text-sky-800 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
          >
            {row.original.name}
          </Link>
        ) : (
          <span className="font-medium">{row.original.name}</span>
        ),
    },
    {
      id: 'description',
      header: 'Description',
      accessorKey: 'description',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search descriptions...',
      cell: ({ getValue }) => {
        const value = getValue() as string
        return (
          <div className="max-w-xs truncate text-gray-500" title={value}>
            {value || '-'}
          </div>
        )
      },
    },
    {
      id: 'isPublic',
      header: 'Visibility',
      accessorKey: 'isPublic',
      enableFiltering: true,
      filterType: 'select',
      filterOptions: [
        { label: 'Public', value: 'true' },
        { label: 'Private', value: 'false' },
      ],
      cell: ({ getValue }) => {
        const isPublic = getValue() as boolean
        if (isPublic) {
          return (
            <Badge variant="default" className="gap-1">
              <Eye className="w-3 h-3" />
              Public
            </Badge>
          )
        }
        return (
          <Badge variant="outline" className="gap-1">
            <EyeOff className="w-3 h-3" />
            Private
          </Badge>
        )
      },
    },
    {
      id: 'columnsCount',
      header: 'Columns',
      accessorFn: (row) => row.columns?.length || 0,
      enableSorting: true,
      enableFiltering: true,
      filterType: 'range',
      filterPlaceholder: 'Any',
      meta: { align: 'right' },
    },
    {
      id: 'filtersCount',
      header: 'Filters',
      accessorFn: (row) => row.filters?.length || 0,
      enableSorting: true,
      enableFiltering: true,
      filterType: 'range',
      filterPlaceholder: 'Any',
      meta: { align: 'right' },
    },
  ]

  const renderRowActions = (row: Row<Report>) => {
    const report = row.original
    if (!report.id) return null

    return (
      <div className="flex justify-end gap-2">
        <Link to="/reports/$id/view" params={{ id: report.id }}>
          <Button variant="ghost" size="sm" title="Run report">
            <Play className="w-4 h-4" />
          </Button>
        </Link>
        <Link to="/reports/$id/edit" params={{ id: report.id }}>
          <Button variant="ghost" size="sm" title="Edit report">
            <Pencil className="w-4 h-4" />
          </Button>
        </Link>
        {onDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(report)}
            className="text-red-500 hover:text-red-700"
            title="Delete report"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>
    )
  }

  const getRowUrl = useCallback((row: Report) => {
    return row.id ? `/reports/${row.id}/view` : undefined
  }, [])

  return (
    <DataGrid
      data={reports}
      columns={columns}
      getRowId={(row) => row.id || row.name}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      emptyMessage="No reports found"
      emptyDescription="Create your first report to get started"
      exportFilename="reports"
    />
  )
}
