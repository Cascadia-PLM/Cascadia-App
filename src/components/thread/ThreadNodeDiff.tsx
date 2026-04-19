import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import {
  Box,
  Factory,
  FileText,
  FlaskConical,
  ListChecks,
  Minus,
  Plus,
  RefreshCw,
  Settings,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ThreadNodeDiff as ThreadNodeDiffData } from '@/lib/services/ThreadComparisonService'
import { cn } from '@/lib/utils'

interface ThreadNodeDiffProps {
  data: ThreadNodeDiffData & { onClick?: () => void }
}

const itemTypeIcons: Record<string, LucideIcon> = {
  Part: Box,
  Document: FileText,
  ChangeOrder: Settings,
  Requirement: ListChecks,
  Task: ListChecks,
  TestCase: FlaskConical,
  TestPlan: FlaskConical,
}

const domainColors: Record<
  string,
  { bg: string; border: string; header: string; text: string; badge: string }
> = {
  requirements: {
    bg: 'bg-purple-50 dark:bg-purple-950',
    border: 'border-purple-300 dark:border-purple-700',
    header: 'bg-purple-100 dark:bg-purple-900',
    text: 'text-purple-700 dark:text-purple-300',
    badge:
      'bg-purple-100 dark:bg-purple-800 text-purple-700 dark:text-purple-300',
  },
  engineering: {
    bg: 'bg-blue-50 dark:bg-blue-950',
    border: 'border-blue-300 dark:border-blue-700',
    header: 'bg-blue-100 dark:bg-blue-900',
    text: 'text-blue-700 dark:text-blue-300',
    badge: 'bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-300',
  },
  manufacturing: {
    bg: 'bg-amber-50 dark:bg-amber-950',
    border: 'border-amber-300 dark:border-amber-700',
    header: 'bg-amber-100 dark:bg-amber-900',
    text: 'text-amber-700 dark:text-amber-300',
    badge: 'bg-amber-100 dark:bg-amber-800 text-amber-700 dark:text-amber-300',
  },
  validation: {
    bg: 'bg-teal-50 dark:bg-teal-950',
    border: 'border-teal-300 dark:border-teal-700',
    header: 'bg-teal-100 dark:bg-teal-900',
    text: 'text-teal-700 dark:text-teal-300',
    badge: 'bg-teal-100 dark:bg-teal-800 text-teal-700 dark:text-teal-300',
  },
}

const stateColors: Record<string, string> = {
  Draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  'In Review':
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  Approved: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  Released: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300',
  Obsolete: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
}

const diffStatusStyles = {
  added: {
    ring: 'ring-2 ring-green-500',
    bg: 'bg-green-50/50 dark:bg-green-950/50',
    badgeColor: 'bg-green-500 text-white',
    Icon: Plus,
  },
  removed: {
    ring: 'ring-2 ring-red-500',
    bg: 'bg-red-50/50 dark:bg-red-950/50',
    badgeColor: 'bg-red-500 text-white',
    Icon: Minus,
  },
  modified: {
    ring: 'ring-2 ring-amber-500',
    bg: 'bg-amber-50/50 dark:bg-amber-950/50',
    badgeColor: 'bg-amber-500 text-white',
    Icon: RefreshCw,
  },
  unchanged: {
    ring: '',
    bg: '',
    badgeColor: '',
    Icon: null,
  },
}

const domainLabels: Record<string, string> = {
  requirements: 'REQ',
  engineering: 'EBOM',
  manufacturing: 'MBOM',
  validation: 'TEST',
}

const domainIcons: Record<string, LucideIcon> = {
  requirements: ListChecks,
  engineering: Wrench,
  manufacturing: Factory,
  validation: FlaskConical,
}

// Map item types to their detail routes
const itemTypeRoutes: Record<string, string> = {
  Part: '/parts/$id',
  Document: '/documents/$id',
  Requirement: '/requirements/$id',
  ChangeOrder: '/change-orders/$id',
  Task: '/tasks/$id',
}

function ThreadNodeDiffComponent({ data }: ThreadNodeDiffProps) {
  const colors = domainColors[data.node.domain] || domainColors.engineering
  const Icon = itemTypeIcons[data.node.itemType] || Box
  const DomainIcon = domainIcons[data.node.domain] || Wrench
  const diffStyles = diffStatusStyles[data.status]
  const route = itemTypeRoutes[data.node.itemType]

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-slate-400 !w-2 !h-2"
      />
      <div
        className={cn(
          'w-[260px] rounded-lg border-2 shadow-sm overflow-hidden relative',
          colors.bg,
          colors.border,
          data.node.isFocalItem &&
            'ring-2 ring-cyan-500 ring-offset-2 dark:ring-offset-slate-900',
          diffStyles.ring,
          diffStyles.bg,
          data.status === 'removed' && 'opacity-60',
        )}
      >
        {/* Diff status badge */}
        {data.status !== 'unchanged' && (
          <div
            className={cn(
              'absolute -top-2 -right-2 w-6 h-6 rounded-full flex items-center justify-center z-10',
              diffStyles.badgeColor,
            )}
          >
            {diffStyles.Icon && <diffStyles.Icon className="h-3.5 w-3.5" />}
          </div>
        )}

        {/* Header with domain indicator */}
        <div
          className={cn(
            'px-3 py-1.5 flex items-center justify-between',
            colors.header,
          )}
        >
          <div className="flex items-center gap-1.5">
            <DomainIcon className={cn('h-3.5 w-3.5', colors.text)} />
            <span className={cn('text-xs font-medium', colors.text)}>
              {domainLabels[data.node.domain]}
            </span>
          </div>
          <span className={cn('text-xs', colors.text)}>
            {data.node.designCode}
          </span>
        </div>

        {/* Main content */}
        <div className="px-3 py-2 space-y-1.5">
          {/* Item number and revision */}
          <div className="flex items-center justify-between">
            {route ? (
              <Link
                to={route as '/parts/$id'}
                params={{ id: data.node.id }}
                className={cn(
                  'text-sm font-semibold text-cyan-600 dark:text-cyan-400 hover:underline',
                  data.status === 'removed' && 'line-through',
                )}
              >
                {data.node.itemNumber}
              </Link>
            ) : (
              <span
                className={cn(
                  'text-sm font-semibold text-slate-700 dark:text-slate-300',
                  data.status === 'removed' && 'line-through',
                )}
              >
                {data.node.itemNumber}
              </span>
            )}
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Rev {data.node.revision}
            </span>
          </div>

          {/* Item name */}
          {data.node.name && (
            <p
              className={cn(
                'text-xs text-slate-600 dark:text-slate-300 truncate',
                data.status === 'removed' && 'line-through',
              )}
            >
              {data.node.name}
            </p>
          )}

          {/* Item type and state badges */}
          <div className="flex items-center gap-2 pt-1">
            <span
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
                colors.badge,
              )}
            >
              <Icon className="h-3 w-3" />
              {data.node.itemType}
            </span>
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-xs',
                stateColors[data.node.state] || stateColors.Draft,
              )}
            >
              {data.node.state}
            </span>
          </div>

          {/* Field changes (if modified and has changes) */}
          {data.status === 'modified' && data.fieldChanges.length > 0 && (
            <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-300 mb-1">
                Changes ({data.fieldChanges.length}):
              </p>
              <div className="space-y-0.5">
                {data.fieldChanges.slice(0, 3).map((change, idx) => (
                  <div key={idx} className="text-xs text-slate-500 truncate">
                    <span className="font-medium">{change.fieldName}:</span>{' '}
                    <span className="text-red-500 line-through">
                      {String(change.oldValue ?? 'null').slice(0, 10)}
                    </span>
                    {' → '}
                    <span className="text-green-600">
                      {String(change.newValue ?? 'null').slice(0, 10)}
                    </span>
                  </div>
                ))}
                {data.fieldChanges.length > 3 && (
                  <p className="text-xs text-slate-400">
                    +{data.fieldChanges.length - 3} more
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-slate-400 !w-2 !h-2"
      />
    </>
  )
}

export const ThreadNodeDiff = memo(ThreadNodeDiffComponent)
