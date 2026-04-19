/**
 * AssemblyReviewPanel - Review composed assemblies
 */

import { AlertCircle, Check, Layers, RefreshCw } from 'lucide-react'
import type { BomNodeDraft } from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

interface AssemblyReviewPanelProps {
  rootAssembly: BomNodeDraft
  onConfirmAssembly: () => void
  onRecompose?: () => void
  className?: string
}

export function AssemblyReviewPanel({
  rootAssembly,
  onConfirmAssembly,
  onRecompose,
  className,
}: AssemblyReviewPanelProps) {
  const assemblies = collectAssemblies(rootAssembly)
  const completedAssemblies = assemblies.filter(
    (a) => a.assemblyComposition?.status === 'complete',
  )
  const failedAssemblies = assemblies.filter(
    (a) => a.assemblyComposition?.status === 'failed',
  )
  const staleAssemblies = assemblies.filter(
    (a) => a.assemblyComposition?.status === 'pending',
  )

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Assembly Review
        </h3>
        <Badge variant="outline" className="text-xs">
          {completedAssemblies.length}/{assemblies.length} composed
        </Badge>
      </div>

      <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
        {assemblies.map((asm) => (
          <div
            key={asm.tempId}
            className="flex items-center gap-2 px-3 py-2 text-sm"
          >
            {asm.assemblyComposition?.status === 'complete' ? (
              <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
            ) : asm.assemblyComposition?.status === 'failed' ? (
              <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
            ) : (
              <Layers className="h-4 w-4 text-slate-400 flex-shrink-0" />
            )}
            <span className="flex-1 truncate text-slate-700 dark:text-slate-300">
              {asm.name}
            </span>
            {asm.assemblyComposition?.status === 'pending' && (
              <Badge
                variant="outline"
                className="text-[9px] px-1 py-0 text-amber-600 border-amber-300"
              >
                stale
              </Badge>
            )}
          </div>
        ))}
      </div>

      {staleAssemblies.length > 0 && onRecompose && (
        <Button
          variant="outline"
          onClick={onRecompose}
          className="w-full gap-2"
          size="sm"
        >
          <RefreshCw className="h-3 w-3" />
          Recompose {staleAssemblies.length} stale assembl
          {staleAssemblies.length === 1 ? 'y' : 'ies'}
        </Button>
      )}

      {failedAssemblies.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {failedAssemblies.length} assembl
          {failedAssemblies.length === 1 ? 'y' : 'ies'} failed composition.
        </p>
      )}

      <Button
        variant="default"
        onClick={onConfirmAssembly}
        className="w-full"
        disabled={completedAssemblies.length === 0}
      >
        <Check className="h-4 w-4 mr-2" />
        Confirm &amp; Complete
      </Button>
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
