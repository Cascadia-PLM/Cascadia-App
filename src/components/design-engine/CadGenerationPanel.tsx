/**
 * CadGenerationPanel - Shows per-part CAD generation status
 */

import { AlertCircle, Box, Check, Clock, Loader2 } from 'lucide-react'
import type {
  BomNodeDraft,
  CadGenerationState,
} from '@/lib/design-engine/types'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

interface CadGenerationPanelProps {
  rootAssembly: BomNodeDraft
  cadState: CadGenerationState | undefined
  className?: string
}

export function CadGenerationPanel({
  rootAssembly,
  cadState,
  className,
}: CadGenerationPanelProps) {
  const parts = collectManufactureParts(rootAssembly)
  const total = cadState?.partsTotal ?? parts.length
  const completed = cadState?.partsCompleted ?? 0
  const failed = cadState?.partsFailed ?? 0
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <div className={cn('space-y-4', className)}>
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
        CAD Generation
      </h3>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            {completed}/{total} parts
          </span>
          <span>{progress}%</span>
        </div>
        <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              failed > 0
                ? 'bg-gradient-to-r from-cyan-500 to-amber-500'
                : 'bg-cyan-500',
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Per-part status list */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
        {parts.map((part) => (
          <PartStatusRow key={part.tempId} part={part} />
        ))}
      </div>

      {/* Summary */}
      {cadState?.status === 'complete' && (
        <div className="text-xs text-slate-500">
          {failed > 0 ? (
            <span className="text-amber-600 dark:text-amber-400">
              {failed} part(s) failed. You can regenerate them individually.
            </span>
          ) : (
            <span className="text-green-600 dark:text-green-400">
              All parts generated successfully.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function PartStatusRow({ part }: { part: BomNodeDraft }) {
  const status = part.cadGeneration?.status ?? 'pending'

  const StatusIcon = {
    pending: Clock,
    generating: Loader2,
    complete: Check,
    failed: AlertCircle,
  }[status]

  const statusColor = {
    pending: 'text-slate-400',
    generating: 'text-cyan-500 animate-spin',
    complete: 'text-green-500',
    failed: 'text-red-500',
  }[status]

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm">
      <StatusIcon className={cn('h-4 w-4 flex-shrink-0', statusColor)} />
      <span className="flex-1 truncate text-slate-700 dark:text-slate-300">
        {part.name}
      </span>

      {/* Generation method badge */}
      {status === 'complete' && part.cadGeneration?.generationMethod && (
        <Badge
          variant={
            part.cadGeneration.generationMethod === 'parametric' ||
            part.cadGeneration.generationMethod === 'mechanism'
              ? 'success'
              : 'default'
          }
          className="text-[9px] px-1 py-0"
        >
          {part.cadGeneration.generationMethod === 'parametric'
            ? 'Parametric'
            : part.cadGeneration.generationMethod === 'mechanism'
              ? 'Mechanism'
              : 'AI'}
        </Badge>
      )}

      {/* Bounding box dimensions */}
      {status === 'complete' && part.cadGeneration?.boundingBox && (
        <Badge variant="outline" className="text-[9px] px-1 py-0 gap-0.5">
          <Box className="h-2 w-2" />
          {formatBoundingBox(part.cadGeneration.boundingBox)}
        </Badge>
      )}

      {/* Error message */}
      {status === 'failed' && part.cadGeneration?.errorMessage && (
        <span
          className="text-[10px] text-red-500 truncate max-w-[200px]"
          title={part.cadGeneration.errorMessage}
        >
          {part.cadGeneration.errorMessage}
        </span>
      )}
    </div>
  )
}

function collectManufactureParts(node: BomNodeDraft): Array<BomNodeDraft> {
  const parts: Array<BomNodeDraft> = []

  function walk(n: BomNodeDraft) {
    if (n.isNew && n.partType === 'Manufacture' && n.children.length === 0) {
      parts.push(n)
    }
    for (const child of n.children) {
      walk(child)
    }
  }

  walk(node)
  return parts
}

function formatBoundingBox(bb: {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}): string {
  const w = (bb.maxX - bb.minX).toFixed(0)
  const h = (bb.maxY - bb.minY).toFixed(0)
  const d = (bb.maxZ - bb.minZ).toFixed(0)
  return `${w}x${h}x${d}`
}
