import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

interface EcoGraphItemNodeProps {
  data: {
    itemId: string
    itemNumber: string
    revision: string
    itemType: string
    name: string
    state: string
    isEco?: boolean
    isInEco?: boolean
    changeAction?: string
    designCode?: string
    branchId?: string
  }
}

const actionColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  release: 'success',
  revise: 'default',
  obsolete: 'destructive',
  replace: 'warning',
  add: 'success',
  remove: 'destructive',
  promote: 'warning',
}

export const EcoGraphItemNode = memo(({ data }: EcoGraphItemNodeProps) => {
  const {
    itemId,
    itemNumber,
    revision,
    itemType,
    name,
    state,
    isEco,
    isInEco,
    changeAction,
    designCode,
    branchId,
  } = data

  // Determine if this node should be greyed out (not in ECO)
  const isGreyedOut = !isEco && !isInEco

  const stateColors: Record<string, string> = {
    Draft: 'bg-slate-200 text-slate-700',
    InReview: 'bg-blue-200 text-blue-700',
    Approved: 'bg-green-200 text-green-700',
    Released: 'bg-green-300 text-green-800',
    Obsolete: 'bg-red-200 text-red-700',
    Concept: 'bg-slate-200 text-slate-700',
    Planning: 'bg-blue-200 text-blue-700',
    Closed: 'bg-green-200 text-green-700',
    Cancelled: 'bg-red-200 text-red-700',
  }

  const typeColors: Record<string, string> = {
    Part: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    Document:
      'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
    ChangeOrder:
      'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
    Requirement:
      'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  }

  // Determine route based on item type
  const getItemRoute = () => {
    const typeRoutes: Record<string, string> = {
      Part: '/parts',
      Document: '/documents',
      ChangeOrder: '/change-orders',
      Requirement: '/requirements',
    }
    return `${typeRoutes[itemType] || '/items'}/${itemId}`
  }

  const routeSearch = branchId ? { branch: branchId } : undefined

  // ECO center node styling
  if (isEco) {
    return (
      <div className="px-4 py-3 rounded-lg border-2 shadow-md min-w-[180px] max-w-[240px] bg-orange-100 dark:bg-orange-900 border-orange-500 transition-all hover:shadow-lg">
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-orange-500"
        />
        <Handle
          type="source"
          position={Position.Left}
          className="!bg-orange-500"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!bg-orange-500"
        />

        <div className="flex items-center justify-between gap-2 mb-2">
          <Link
            to={getItemRoute()}
            search={routeSearch as any}
            className="font-semibold text-sm text-slate-900 dark:text-white hover:text-orange-600 dark:hover:text-orange-400 transition-colors"
          >
            {itemNumber}
          </Link>
          <Badge variant="outline" className="text-xs">
            {state}
          </Badge>
        </div>

        {name && (
          <div className="text-xs text-slate-600 dark:text-slate-400 mb-2 line-clamp-2">
            {name}
          </div>
        )}

        <div className="text-xs font-semibold text-orange-600 dark:text-orange-400">
          Change Order
        </div>
      </div>
    )
  }

  // Item node styling - affected items are highlighted, non-affected are greyed out
  return (
    <div
      className={cn(
        'px-3 py-2 rounded-lg border-2 shadow-sm min-w-[160px] max-w-[220px] transition-all hover:shadow-md',
        isGreyedOut
          ? 'bg-slate-50 dark:bg-slate-900 border-slate-300 dark:border-slate-700 opacity-60'
          : 'bg-white dark:bg-slate-800 border-cyan-400 dark:border-cyan-600 shadow-md',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className={cn('!bg-slate-400', isInEco && '!bg-cyan-500')}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className={cn('!bg-slate-400', isInEco && '!bg-cyan-500')}
      />
      <Handle
        type="target"
        position={Position.Left}
        className={cn('!bg-slate-400', isInEco && '!bg-cyan-500')}
      />
      <Handle
        type="source"
        position={Position.Right}
        className={cn('!bg-slate-400', isInEco && '!bg-cyan-500')}
      />

      {/* Item header */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <Link
          to={getItemRoute()}
          search={routeSearch as any}
          className={cn(
            'font-semibold text-xs transition-colors',
            isGreyedOut
              ? 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
              : 'text-slate-900 dark:text-white hover:text-cyan-600 dark:hover:text-cyan-400',
          )}
        >
          {itemNumber}
        </Link>
        <span
          className={cn(
            'text-[10px] px-1 py-0.5 rounded',
            isGreyedOut
              ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500'
              : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300',
          )}
        >
          {revision}
        </span>
      </div>

      {/* Item name */}
      {name && (
        <div
          className={cn(
            'text-[10px] mb-1 line-clamp-1',
            isGreyedOut
              ? 'text-slate-400 dark:text-slate-500'
              : 'text-slate-600 dark:text-slate-400',
          )}
        >
          {name}
        </div>
      )}

      {/* Badges row */}
      <div className="flex flex-wrap gap-1">
        <span
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded',
            isGreyedOut
              ? 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
              : typeColors[itemType] || 'bg-gray-100 text-gray-700',
          )}
        >
          {itemType}
        </span>
        {!isGreyedOut && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${stateColors[state] || 'bg-gray-200 text-gray-700'}`}
          >
            {state}
          </span>
        )}
      </div>

      {/* Change action badge - only for affected items */}
      {isInEco && changeAction && (
        <Badge
          variant={actionColors[changeAction] ?? 'secondary'}
          className="text-[10px] mt-1"
        >
          {changeAction}
        </Badge>
      )}

      {/* Design code if from external design */}
      {designCode && !isGreyedOut && (
        <div className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
          {designCode}
        </div>
      )}
    </div>
  )
})

EcoGraphItemNode.displayName = 'EcoGraphItemNode'
