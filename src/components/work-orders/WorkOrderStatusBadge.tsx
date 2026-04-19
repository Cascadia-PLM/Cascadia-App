import type { WorkOrderStatus } from '@/lib/items/types/work-order'
import { Badge } from '@/components/ui'
import { cn } from '@/lib/utils'

const statusConfig: Record<
  WorkOrderStatus,
  { className: string; label: string }
> = {
  'Not Started': {
    className:
      'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
    label: 'Not Started',
  },
  'In Progress': {
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    label: 'In Progress',
  },
  Complete: {
    className:
      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    label: 'Complete',
  },
  Cancelled: {
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    label: 'Cancelled',
  },
}

export function WorkOrderStatusBadge({ status }: { status: WorkOrderStatus }) {
  const config = statusConfig[status] || statusConfig['Not Started']
  return (
    <Badge variant="secondary" className={cn('font-medium', config.className)}>
      {config.label}
    </Badge>
  )
}
