import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Eye, GitFork, MoreVertical, Play } from 'lucide-react'
import type { DataGridColumn, Row } from '@/components/ui'
import { Badge, Button, DataGrid } from '@/components/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import {
  stageLabel,
  statusBadgeVariant,
  statusLabel,
} from '@/components/design-engine/session-labels'

export interface DesignSessionRow {
  id: string
  userId: string
  title: string | null
  stage: string
  status: string
  programId: string | null
  programCode?: string
  programName?: string
  updatedAt: string | Date
  createdAt: string | Date
  completedAt: string | Date | null
  forkedFromSessionId?: string | null
}

interface SessionsTableProps {
  items: Array<DesignSessionRow>
}

function formatDate(value: string | Date | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleDateString()
}

const columns: Array<DataGridColumn<DesignSessionRow>> = [
  {
    id: 'title',
    header: 'Session',
    accessorKey: 'title',
    enableFiltering: true,
    filterType: 'text',
    filterPlaceholder: 'Filter...',
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5">
        <Link
          to="/designs/collaborative/$sessionId"
          params={{ sessionId: row.original.id }}
          className="font-medium text-cyan-600 dark:text-cyan-400 hover:underline"
        >
          {row.original.title || 'Untitled session'}
        </Link>
        {row.original.forkedFromSessionId && (
          <GitFork
            className="h-3 w-3 text-slate-400 flex-shrink-0"
            aria-label="Forked from another session"
          />
        )}
      </span>
    ),
  },
  {
    id: 'stage',
    header: 'Stage',
    accessorKey: 'stage',
    enableFiltering: true,
    filterType: 'text',
    filterPlaceholder: 'Filter...',
    cell: ({ getValue }) => (
      <Badge variant="outline">{stageLabel(getValue() as string)}</Badge>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    accessorKey: 'status',
    enableFiltering: true,
    filterType: 'multiSelect',
    filterOptions: [
      { label: 'Active', value: 'active' },
      { label: 'Completed', value: 'completed' },
      { label: 'Failed', value: 'failed' },
    ],
    cell: ({ getValue }) => {
      const value = getValue() as string
      return <Badge variant={statusBadgeVariant(value)}>{statusLabel(value)}</Badge>
    },
  },
  {
    id: 'programCode',
    header: 'Program',
    accessorKey: 'programCode',
    enableFiltering: true,
    filterType: 'text',
    filterPlaceholder: 'Filter...',
    cell: ({ row }) => {
      const { programId, programCode } = row.original
      if (!programId || !programCode)
        return <span className="text-slate-400">-</span>
      return (
        <Link
          to="/programs/$id"
          params={{ id: programId }}
          className="text-cyan-600 dark:text-cyan-400 hover:underline"
        >
          {programCode}
        </Link>
      )
    },
  },
  {
    id: 'updatedAt',
    header: 'Updated',
    accessorKey: 'updatedAt',
    cell: ({ getValue }) => formatDate(getValue() as string | Date | null),
  },
  {
    id: 'createdAt',
    header: 'Created',
    accessorKey: 'createdAt',
    cell: ({ getValue }) => formatDate(getValue() as string | Date | null),
  },
]

export function SessionsTable({ items }: SessionsTableProps) {
  const renderRowActions = useCallback((row: Row<DesignSessionRow>) => {
    const session = row.original
    const isActive = session.status === 'active'
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8">
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link
              to="/designs/collaborative/$sessionId"
              params={{ sessionId: session.id }}
            >
              {isActive ? (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Resume
                </>
              ) : (
                <>
                  <Eye className="mr-2 h-4 w-4" />
                  Open
                </>
              )}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }, [])

  return (
    <DataGrid
      data={items}
      columns={columns}
      getRowId={(row) => row.id}
      enableRowActions
      renderRowActions={renderRowActions}
      emptyMessage="No design sessions"
      emptyDescription="Start a collaborative design from the AI assistant to see it here"
      exportFilename="design-sessions"
    />
  )
}
