/**
 * AssemblyPanel - Assembly composition status with per-assembly progress
 */

import { AlertCircle, Check, Clock, Layers, Loader2 } from 'lucide-react'
import type {
  BomNodeDraft,
  CadGenerationState,
} from '@/lib/design-engine/types'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

interface AssemblyPanelProps {
  rootAssembly: BomNodeDraft
  cadState: CadGenerationState | undefined
  className?: string
}

export function AssemblyPanel({
  rootAssembly,
  cadState,
  className,
}: AssemblyPanelProps) {
  const assemblies = collectAssemblies(rootAssembly)
  const total = cadState?.assembliesTotal ?? assemblies.length
  const completed = cadState?.assembliesCompleted ?? 0
  const failed = cadState?.assembliesFailed ?? 0
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <div className={cn('space-y-4', className)}>
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
        Assembly Composition
      </h3>

      {/* Progress bar */}
      {total > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>
              {completed}/{total} assemblies
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
      )}

      {/* Per-assembly status */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
        {assemblies.map((asm) => (
          <AssemblyStatusRow key={asm.tempId} assembly={asm} />
        ))}
      </div>
    </div>
  )
}

function AssemblyStatusRow({ assembly }: { assembly: BomNodeDraft }) {
  const status = assembly.assemblyComposition?.status ?? 'pending'

  const StatusIcon = {
    pending: Clock,
    planning: Loader2,
    rendering: Loader2,
    complete: Check,
    code_only: Check,
    failed: AlertCircle,
  }[status]

  const statusColor = {
    pending: 'text-slate-400',
    planning: 'text-cyan-500 animate-spin',
    rendering: 'text-blue-500 animate-spin',
    complete: 'text-green-500',
    code_only: 'text-amber-500',
    failed: 'text-red-500',
  }[status]

  const statusLabel = {
    pending: 'Pending',
    planning: 'Planning...',
    rendering: 'Rendering...',
    complete: 'Complete',
    code_only: 'KCL Only',
    failed: 'Failed',
  }[status]

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm">
      <StatusIcon className={cn('h-4 w-4 flex-shrink-0', statusColor)} />
      <Layers className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
      <span className="flex-1 truncate text-slate-700 dark:text-slate-300">
        {assembly.name}
      </span>
      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
        {assembly.children.length} parts
      </Badge>
      <span className="text-[10px] text-slate-500">{statusLabel}</span>
    </div>
  )
}

function collectAssemblies(node: BomNodeDraft): Array<BomNodeDraft> {
  const assemblies: Array<BomNodeDraft> = []

  function walk(n: BomNodeDraft) {
    if (n.children.length > 0) {
      assemblies.push(n)
    }
    for (const child of n.children) {
      walk(child)
    }
  }

  walk(node)
  return assemblies
}
