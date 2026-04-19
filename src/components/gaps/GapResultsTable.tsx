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
  Gap,
  GapSeverity,
  GapType,
} from '@/lib/services/GapAnalysisService'
import type { ThreadDomain } from '@/lib/services/ThreadService'
import { DataGrid } from '@/components/ui/DataGrid'
import { Badge, Checkbox } from '@/components/ui'
import { cn } from '@/lib/utils'

interface GapResultsTableProps {
  gaps: Array<Gap>
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
  GapSeverity,
  'destructive' | 'warning' | 'outline'
> = {
  critical: 'destructive',
  major: 'warning',
  minor: 'outline',
}

const severityLabels: Record<GapSeverity, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
}

const gapTypeLabels: Record<GapType, string> = {
  unallocated_requirement: 'Not Allocated',
  unsatisfied_requirement: 'Not Satisfied',
  unverified_requirement: 'Not Verified',
  untested_part: 'Not Tested',
  unmapped_ebom_item: 'Not Mapped to MBOM',
  orphan_mbom_item: 'Orphan MBOM Item',
  missing_documentation: 'Missing Docs',
}

/**
 * Table showing detailed gap analysis results.
 * Supports filtering by gap type, domain, and severity, and row selection.
 */
export function GapResultsTable({
  gaps,
  onSelectionChange,
  className,
}: GapResultsTableProps) {
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
    if (selectedIds.size === gaps.length) {
      setSelectedIds(new Set())
      onSelectionChange?.([])
    } else {
      const allIds = new Set(gaps.map((gap) => gap.itemId))
      setSelectedIds(allIds)
      onSelectionChange?.(Array.from(allIds))
    }
  }

  // Define columns
  const columns = useMemo<Array<DataGridColumn<Gap>>>(
    () => [
      // Selection column
      {
        id: 'select',
        header: '',
        cell: ({ row }) => (
          <Checkbox
            checked={selectedIds.has(row.original.itemId)}
            onCheckedChange={() => toggleSelection(row.original.itemId)}
            aria-label={`Select ${row.original.itemNumber}`}
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
        accessorFn: (row) => row.itemNumber,
        cell: ({ row }) => {
          const gap = row.original
          const itemUrl = getItemUrl(gap.itemType, gap.itemId)
          return (
            <div className="flex items-center gap-2">
              <Link
                to={itemUrl as any}
                className="text-cyan-600 hover:underline font-medium"
              >
                {gap.itemNumber}
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
        accessorFn: (row) => row.itemName ?? '',
        cell: ({ row }) => (
          <span className="text-slate-700 dark:text-slate-300 truncate max-w-[200px] block">
            {row.original.itemName || '-'}
          </span>
        ),
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text',
      },
      // Type
      {
        id: 'itemType',
        header: 'Item Type',
        accessorFn: (row) => row.itemType,
        cell: ({ row }) => (
          <span className="text-slate-700 dark:text-slate-300">
            {row.original.itemType}
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
      // Gap Type
      {
        id: 'type',
        header: 'Gap Type',
        accessorFn: (row) => row.type,
        cell: ({ row }) => (
          <Badge variant="secondary" className="text-xs">
            {gapTypeLabels[row.original.type]}
          </Badge>
        ),
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect',
        filterOptions: [
          { label: 'Not Allocated', value: 'unallocated_requirement' },
          { label: 'Not Satisfied', value: 'unsatisfied_requirement' },
          { label: 'Not Verified', value: 'unverified_requirement' },
          { label: 'Not Tested', value: 'untested_part' },
          { label: 'Not Mapped to MBOM', value: 'unmapped_ebom_item' },
          { label: 'Orphan MBOM', value: 'orphan_mbom_item' },
          { label: 'Missing Docs', value: 'missing_documentation' },
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
          { label: 'Major', value: 'major' },
          { label: 'Minor', value: 'minor' },
        ],
      },
      // Priority (for requirements)
      {
        id: 'priority',
        header: 'Priority',
        accessorFn: (row) => row.priority ?? '',
        cell: ({ row }) => {
          const priority = row.original.priority
          if (!priority) return <span className="text-slate-400">-</span>
          return (
            <Badge
              variant={priority === 'MustHave' ? 'destructive' : 'secondary'}
              className="text-xs"
            >
              {priority}
            </Badge>
          )
        },
        enableSorting: true,
        enableFiltering: true,
        filterType: 'select',
        filterOptions: [
          { label: 'MustHave', value: 'MustHave' },
          { label: 'ShouldHave', value: 'ShouldHave' },
          { label: 'CouldHave', value: 'CouldHave' },
          { label: 'WontHave', value: 'WontHave' },
        ],
      },
      // Suggestion
      {
        id: 'suggestion',
        header: 'Suggested Action',
        accessorFn: (row) => row.suggestion,
        cell: ({ row }) => (
          <span className="text-sm text-slate-600 dark:text-slate-400">
            {row.original.suggestion}
          </span>
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
            checked={selectedIds.size === gaps.length && gaps.length > 0}
            onCheckedChange={toggleAll}
            aria-label="Select all gaps"
          />
          <span className="text-sm text-slate-500">
            {selectedIds.size > 0
              ? `${selectedIds.size} of ${gaps.length} selected`
              : `${gaps.length} gaps`}
          </span>
        </div>
      )}

      {/* Table */}
      <DataGrid
        data={gaps}
        columns={columns}
        getRowId={(row) => row.id}
        enablePagination={true}
        enableSorting={true}
        enableFiltering={true}
        enableGlobalFilter={true}
        enableExport={true}
        exportFilename="gap-analysis"
        defaultPageSize={20}
        pageSizeOptions={[10, 20, 50, 100]}
        emptyMessage="No gaps found"
        emptyDescription="This design has complete traceability coverage"
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
