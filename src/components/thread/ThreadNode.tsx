import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import {
  Box,
  Factory,
  FileText,
  ListChecks,
  Settings,
  Wrench,
} from 'lucide-react'
import type { Node, NodeProps } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import type { ThreadNode as ThreadNodeData } from '@/lib/services/ThreadService'

type ThreadNodeProps = NodeProps<Node>

const itemTypeIcons: Record<string, LucideIcon> = {
  Part: Box,
  Document: FileText,
  ChangeOrder: Settings,
  Requirement: ListChecks,
  Task: ListChecks,
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
  validation: ListChecks,
}

// Map item types to their detail routes
const itemTypeRoutes: Record<string, string> = {
  Part: '/parts/$id',
  Document: '/documents/$id',
  Requirement: '/requirements/$id',
  ChangeOrder: '/change-orders/$id',
  Task: '/tasks/$id',
}

function ThreadNodeComponent({
  data: rawData,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
}: ThreadNodeProps) {
  const data = rawData as unknown as ThreadNodeData & { onClick?: () => void }
  const colors = domainColors[data.domain] || domainColors.engineering
  const Icon = itemTypeIcons[data.itemType] || Box
  const DomainIcon = domainIcons[data.domain] || Wrench
  const route = itemTypeRoutes[data.itemType]

  return (
    <>
      <Handle
        type="target"
        position={targetPosition}
        className="!bg-slate-400 !w-2 !h-2"
      />
      <div
        className={`
          w-[260px] rounded-lg border-2 shadow-sm overflow-hidden
          ${colors.bg} ${colors.border}
          ${data.isFocalItem ? 'ring-2 ring-cyan-500 ring-offset-2 dark:ring-offset-slate-900' : ''}
        `}
      >
        {/* Header with domain indicator */}
        <div
          className={`px-3 py-1.5 ${colors.header} flex items-center justify-between`}
        >
          <div className="flex items-center gap-1.5">
            <DomainIcon className={`h-3.5 w-3.5 ${colors.text}`} />
            <span className={`text-xs font-medium ${colors.text}`}>
              {domainLabels[data.domain] || data.domain}
            </span>
          </div>
          <span className={`text-xs ${colors.text}`}>{data.designCode}</span>
        </div>

        {/* Main content */}
        <div className="px-3 py-2 space-y-1.5">
          {/* Item number and revision */}
          <div className="flex items-center justify-between">
            {route ? (
              <Link
                to={route as '/parts/$id'}
                params={{ id: data.id }}
                className="text-sm font-semibold text-cyan-600 dark:text-cyan-400 hover:underline"
              >
                {data.itemNumber}
              </Link>
            ) : (
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                {data.itemNumber}
              </span>
            )}
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Rev {data.revision}
            </span>
          </div>

          {/* Item name */}
          {data.name && (
            <p className="text-xs text-slate-600 dark:text-slate-300 truncate">
              {data.name}
            </p>
          )}

          {/* Item type and state badges */}
          <div className="flex items-center gap-2 pt-1">
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${colors.badge}`}
            >
              <Icon className="h-3 w-3" />
              {data.itemType}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded text-xs ${stateColors[data.state] || stateColors.Draft}`}
            >
              {data.state}
            </span>
          </div>
        </div>
      </div>
      <Handle
        type="source"
        position={sourcePosition}
        className="!bg-slate-400 !w-2 !h-2"
      />
    </>
  )
}

export const ThreadNodeComponent_ = memo(ThreadNodeComponent)
export { ThreadNodeComponent_ as ThreadNode }
