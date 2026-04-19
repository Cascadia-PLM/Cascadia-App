import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { GitCommit, GitMerge, Layers, Tag } from 'lucide-react'
import type { NodeProps } from '@xyflow/react'
import type { CommitGraphNode } from '@/lib/versioning/graph-types'
import { Badge } from '@/components/ui/Badge'

// Color schemes for different branch types
const branchColors: Record<
  string,
  { bg: string; border: string; text: string; icon: string }
> = {
  main: {
    bg: 'bg-green-50 dark:bg-green-900/30',
    border: 'border-green-300 dark:border-green-700',
    text: 'text-green-700 dark:text-green-300',
    icon: 'text-green-600 dark:text-green-400',
  },
  eco: {
    bg: 'bg-orange-50 dark:bg-orange-900/30',
    border: 'border-orange-300 dark:border-orange-700',
    text: 'text-orange-700 dark:text-orange-300',
    icon: 'text-orange-600 dark:text-orange-400',
  },
  workspace: {
    bg: 'bg-blue-50 dark:bg-blue-900/30',
    border: 'border-blue-300 dark:border-blue-700',
    text: 'text-blue-700 dark:text-blue-300',
    icon: 'text-blue-600 dark:text-blue-400',
  },
  release: {
    bg: 'bg-purple-50 dark:bg-purple-900/30',
    border: 'border-purple-300 dark:border-purple-700',
    text: 'text-purple-700 dark:text-purple-300',
    icon: 'text-purple-600 dark:text-purple-400',
  },
}

function getColorClasses(branchType: string) {
  return branchColors[branchType] ?? branchColors.main
}

/**
 * Format relative time from date string
 */
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 30) {
    return date.toLocaleDateString()
  } else if (diffDays > 0) {
    return `${diffDays}d ago`
  } else if (diffHours > 0) {
    return `${diffHours}h ago`
  } else if (diffMins > 0) {
    return `${diffMins}m ago`
  } else {
    return 'just now'
  }
}

/**
 * Format change stats as a compact string
 */
function formatChangeStats(stats?: {
  added: number
  modified: number
  deleted: number
}): string | null {
  if (!stats) return null
  const parts: Array<string> = []
  if (stats.added > 0) parts.push(`+${stats.added}`)
  if (stats.modified > 0) parts.push(`~${stats.modified}`)
  if (stats.deleted > 0) parts.push(`-${stats.deleted}`)
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * Truncate message to specified length
 */
function truncateMessage(message: string, maxLength: number = 40): string {
  if (message.length <= maxLength) return message
  return message.substring(0, maxLength - 3) + '...'
}

// Fixed width must match NODE_WIDTH constant in graph views for proper edge alignment
const COMMIT_NODE_WIDTH = 220

function CommitNodeComponent({ data, selected }: NodeProps<CommitGraphNode>) {
  const colors = getColorClasses(data.branchType)
  const hasTags = data.tags && data.tags.length > 0
  const changeStats = formatChangeStats(data.changeStats)
  // Show merge icon for merge commits OR ECO release commits
  const isEcoRelated = data.isMergeCommit || !!data.changeOrderItemId
  const hasEcoNumber = !!data.ecoNumber
  // Check if this is a consolidated node
  const isConsolidated =
    data.isConsolidated && (data.consolidatedCount ?? 0) > 1

  const handleClick = () => {
    if (data.onViewCommit) {
      data.onViewCommit(data.commitId)
    }
  }

  return (
    <div
      onClick={handleClick}
      className={`
        relative rounded-lg border-2 shadow-sm
        transition-all duration-200 cursor-pointer
        hover:shadow-md hover:scale-[1.02]
        ${colors.bg} ${colors.border}
        ${selected ? 'ring-2 ring-cyan-500 ring-offset-2 dark:ring-offset-slate-900' : ''}
      `}
      style={{ width: COMMIT_NODE_WIDTH }}
    >
      {/* Connection handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-slate-400 dark:!bg-slate-500 !border-2 !border-white dark:!border-slate-800"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-slate-400 dark:!bg-slate-500 !border-2 !border-white dark:!border-slate-800"
      />

      {/* Node content */}
      <div className="p-3">
        {/* Header with icons */}
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            {/* Commit type icon */}
            {isConsolidated ? (
              <Layers className={`h-4 w-4 ${colors.icon}`} />
            ) : isEcoRelated ? (
              <GitMerge className={`h-4 w-4 ${colors.icon}`} />
            ) : (
              <GitCommit className={`h-4 w-4 ${colors.icon}`} />
            )}
            {/* Tag indicator */}
            {hasTags && (
              <Tag className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
            )}
          </div>

          <div className="flex items-center gap-1">
            {/* Consolidated count badge */}
            {isConsolidated && (
              <Badge variant="secondary" className="text-xs py-0 px-1.5">
                {data.consolidatedCount} commits
              </Badge>
            )}
            {/* Change stats badge */}
            {changeStats && (
              <Badge
                variant="outline"
                className="text-xs font-mono py-0 px-1.5"
              >
                {changeStats}
              </Badge>
            )}
          </div>
        </div>

        {/* Commit message */}
        <p className={`text-sm font-medium leading-tight ${colors.text}`}>
          {truncateMessage(data.message)}
        </p>

        {/* Author and time */}
        <div className="flex items-center gap-2 mt-2 text-xs text-slate-500 dark:text-slate-400">
          <span className="truncate max-w-[100px]">{data.author.name}</span>
          <span className="text-slate-400 dark:text-slate-500">•</span>
          <span>{formatRelativeTime(data.date)}</span>
        </div>

        {/* Tags (if any) */}
        {hasTags && (
          <div className="flex flex-wrap gap-1 mt-2">
            {data.tags!.slice(0, 2).map((tag) => (
              <Badge
                key={tag.id}
                variant="default"
                className="text-[10px] py-0 px-1.5"
              >
                {tag.name}
              </Badge>
            ))}
            {data.tags!.length > 2 && (
              <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                +{data.tags!.length - 2}
              </Badge>
            )}
          </div>
        )}

        {/* ECO number for ECO-related commits (merges and releases) */}
        {hasEcoNumber && (
          <Badge variant="warning" className="mt-2 text-[10px]">
            {data.ecoNumber}
          </Badge>
        )}
      </div>
    </div>
  )
}

export const CommitNode = memo(CommitNodeComponent)
