import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Cog,
  ExternalLink,
  Factory,
  FileText,
  FlaskConical,
} from 'lucide-react'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import type {
  ImpactSeverity,
  ImpactedItem,
} from '@/lib/services/ImpactAnalysisService'
import type { ThreadDomain } from '@/lib/services/ThreadService'
import { DataGrid } from '@/components/ui/DataGrid'
import { Badge, Checkbox } from '@/components/ui'
import { cn } from '@/lib/utils'

interface ImpactResultsTableProps {
  items: Array<ImpactedItem>
  onSelectionChange?: (selectedIds: Array<string>) => void
  className?: string
}

const domainIcons: Record<ThreadDomain, typeof Cog> = {
  requirements: FileText,
  engineering: Cog,
  manufacturing: Factory,
  validation: FlaskConical,
}

const domainLabels: Record<ThreadDomain, string> = {
  requirements: 'Requirements',
  engineering: 'Engineering',
  manufacturing: 'Manufacturing',
  validation: 'Validation',
}

const severityVariants: Record<
  ImpactSeverity,
  'destructive' | 'warning' | 'secondary' | 'outline'
> = {
  critical: 'destructive',
  high: 'warning',
  medium: 'secondary',
  low: 'outline',
}

const severityLabels: Record<ImpactSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

/**
 * Table showing detailed impact analysis results.
 * Supports filtering by domain and severity, and row selection for ECO creation.
 */
export function ImpactResultsTable({
  items,
  onSelectionChange,
  className,
}: ImpactResultsTableProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Toggle selection of a single item
  const toggleSelection = (itemId: string) => {
    const newSelection = new Set(selectedIds)
    if (newSelection.has(itemId)) {
      newSelection.delete(itemId)
    } else {
      newSelection.add(itemId)
    }
    setSelectedIds(newSelection)
    onSelectionChange?.(Array.from(newSelection))
  }

  // Toggle all items
  const toggleAll = () => {
    if (selectedIds.size === items.length) {
      setSelectedIds(new Set())
      onSelectionChange?.([])
    } else {
      const allIds = new Set(items.map((item) => item.item.id))
      setSelectedIds(allIds)
      onSelectionChange?.(Array.from(allIds))
    }
  }

  // Define columns
  const columns = useMemo<Array<DataGridColumn<ImpactedItem>>>(
    () => [
      // Selection column
      {
        id: 'select',
        header: '',
        cell: ({ row }) => (
          <Checkbox
            checked={selectedIds.has(row.original.item.id)}
            onCheckedChange={() => toggleSelection(row.original.item.id)}
            aria-label={`Select ${row.original.item.itemNumber}`}
          />
        ),
        enableSorting: false,
        enableFiltering: false,
        meta: { width: '40px' },
      },
      // Item Number
      {
        id: 'itemNumber',
        header: 'Item Number',
        accessorFn: (row) => row.item.itemNumber,
        cell: ({ row }) => {
          const item = row.original.item
          const itemUrl = getItemUrl(item.itemType, item.id)
          return (
            <div className="flex items-center gap-2">
              <Link
                to={itemUrl as any}
                className="text-cyan-600 hover:underline font-medium"
              >
                {item.itemNumber}
              </Link>
              <Link
                to={itemUrl as any}
                target="_blank"
                className="text-slate-400 hover:text-slate-600"
              >
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          )
        },
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text',
        filterPlaceholder: 'Filter by item number...',
      },
      // Name
      {
        id: 'name',
        header: 'Name',
        accessorFn: (row) => row.item.name ?? '',
        cell: ({ row }) => (
          <span className="text-slate-700 dark:text-slate-300 truncate max-w-[200px] block">
            {row.original.item.name || '-'}
          </span>
        ),
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text',
      },
      // Type
      {
        id: 'itemType',
        header: 'Type',
        accessorFn: (row) => row.item.itemType,
        cell: ({ row }) => (
          <span className="text-slate-700 dark:text-slate-300">
            {row.original.item.itemType}
          </span>
        ),
        enableSorting: true,
        enableFiltering: true,
        filterType: 'select',
        filterOptions: [
          { label: 'Part', value: 'Part' },
          { label: 'Requirement', value: 'Requirement' },
          { label: 'Document', value: 'Document' },
          { label: 'TestCase', value: 'TestCase' },
        ],
      },
      // Domain
      {
        id: 'domain',
        header: 'Domain',
        accessorFn: (row) => row.domain,
        cell: ({ row }) => {
          const domain = row.original.domain
          const Icon = domainIcons[domain]
          return (
            <div className="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300">
              <Icon className="h-3.5 w-3.5" />
              <span>{domainLabels[domain]}</span>
            </div>
          )
        },
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect',
        filterOptions: [
          { label: 'Requirements', value: 'requirements' },
          { label: 'Engineering', value: 'engineering' },
          { label: 'Manufacturing', value: 'manufacturing' },
          { label: 'Validation', value: 'validation' },
        ],
      },
      // Severity
      {
        id: 'severity',
        header: 'Severity',
        accessorFn: (row) => row.severity,
        cell: ({ row }) => {
          const severity = row.original.severity
          return (
            <Badge variant={severityVariants[severity]}>
              {severityLabels[severity]}
            </Badge>
          )
        },
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect',
        filterOptions: [
          { label: 'Critical', value: 'critical' },
          { label: 'High', value: 'high' },
          { label: 'Medium', value: 'medium' },
          { label: 'Low', value: 'low' },
        ],
      },
      // Impact Path
      {
        id: 'impactPath',
        header: 'Impact Path',
        accessorFn: (row) => row.impactPath.join(' → '),
        cell: ({ row }) => (
          <span className="text-xs text-slate-500 font-mono">
            {row.original.impactPath.join(' → ')}
          </span>
        ),
        enableSorting: false,
        enableFiltering: false,
      },
      // Reason
      {
        id: 'reason',
        header: 'Reason',
        accessorFn: (row) => row.reason,
        cell: ({ row }) => (
          <span className="text-sm text-slate-600 dark:text-slate-400">
            {row.original.reason}
          </span>
        ),
        enableSorting: false,
        enableFiltering: false,
      },
      // Required Action
      {
        id: 'requiredAction',
        header: 'Required Action',
        accessorFn: (row) => row.requiredAction ?? '',
        cell: ({ row }) =>
          row.original.requiredAction ? (
            <span className="text-sm text-orange-600 dark:text-orange-400">
              {row.original.requiredAction}
            </span>
          ) : (
            <span className="text-slate-400">-</span>
          ),
        enableSorting: false,
        enableFiltering: false,
      },
    ],
    [selectedIds],
  )

  return (
    <div className={cn('space-y-3 w-full max-w-full min-w-0', className)}>
      {/* Selection Controls */}
      {onSelectionChange && (
        <div className="flex items-center gap-3">
          <Checkbox
            checked={selectedIds.size === items.length && items.length > 0}
            onCheckedChange={toggleAll}
            aria-label="Select all items"
          />
          <span className="text-sm text-slate-500">
            {selectedIds.size > 0
              ? `${selectedIds.size} of ${items.length} selected`
              : `${items.length} items`}
          </span>
        </div>
      )}

      {/* Table */}
      <DataGrid
        data={items}
        columns={columns}
        getRowId={(row) => row.item.id}
        enablePagination={true}
        enableSorting={true}
        enableFiltering={true}
        enableGlobalFilter={true}
        enableExport={true}
        exportFilename="impact-analysis"
        defaultPageSize={20}
        pageSizeOptions={[10, 20, 50, 100]}
        emptyMessage="No impacted items found"
        emptyDescription="This change does not appear to impact any other items"
      />
    </div>
  )
}

/**
 * Get the URL for an item based on its type.
 */
function getItemUrl(itemType: string, itemId: string): string {
  switch (itemType) {
    case 'Part':
      return `/parts/${itemId}`
    case 'Requirement':
      return `/requirements/${itemId}`
    case 'Document':
      return `/documents/${itemId}`
    case 'TestCase':
      return `/test-cases/${itemId}`
    case 'ChangeOrder':
      return `/change-orders/${itemId}`
    default:
      return `/items/${itemId}`
  }
}
