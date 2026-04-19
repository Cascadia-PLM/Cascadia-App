/**
 * CadReviewPanel - Review generated CAD with per-part actions
 */

import { useState } from 'react'
import { AlertCircle, Check, RefreshCw, SkipForward } from 'lucide-react'
import type { BomNodeDraft } from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

interface CadReviewPanelProps {
  rootAssembly: BomNodeDraft
  onRegeneratePart: (tempId: string, feedback?: string) => void
  onConfirmCad: () => void
  isRegenerating?: boolean
  className?: string
}

export function CadReviewPanel({
  rootAssembly,
  onRegeneratePart,
  onConfirmCad,
  isRegenerating,
  className,
}: CadReviewPanelProps) {
  const parts = collectCadParts(rootAssembly)
  const completedParts = parts.filter(
    (p) => p.cadGeneration?.status === 'complete',
  )
  const failedParts = parts.filter((p) => p.cadGeneration?.status === 'failed')

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          CAD Review
        </h3>
        <Badge variant="outline" className="text-xs">
          {completedParts.length}/{parts.length} generated
        </Badge>
      </div>

      <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
        {parts.map((part) => (
          <PartReviewRow
            key={part.tempId}
            part={part}
            onRegenerate={onRegeneratePart}
            isRegenerating={isRegenerating}
          />
        ))}
      </div>

      {failedParts.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {failedParts.length} part(s) failed. Regenerate them or proceed
          without.
        </p>
      )}

      <Button
        variant="default"
        onClick={onConfirmCad}
        className="w-full"
        disabled={completedParts.length === 0 || isRegenerating}
      >
        <Check className="h-4 w-4 mr-2" />
        Confirm CAD &amp; Proceed to Assembly
      </Button>
    </div>
  )
}

function PartReviewRow({
  part,
  onRegenerate,
  isRegenerating,
}: {
  part: BomNodeDraft
  onRegenerate: (tempId: string, feedback?: string) => void
  isRegenerating?: boolean
}) {
  const [feedbackText, setFeedbackText] = useState('')
  const [showFeedback, setShowFeedback] = useState(false)
  const status = part.cadGeneration?.status ?? 'pending'

  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 text-sm">
        {status === 'complete' ? (
          <Check className="h-4 w-4 text-green-500 flex-shrink-0" />
        ) : status === 'failed' ? (
          <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
        ) : (
          <SkipForward className="h-4 w-4 text-slate-400 flex-shrink-0" />
        )}

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

        {(status === 'complete' || status === 'failed') && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs gap-1"
            onClick={() => {
              if (showFeedback && feedbackText) {
                onRegenerate(part.tempId, feedbackText)
                setShowFeedback(false)
                setFeedbackText('')
              } else {
                setShowFeedback(!showFeedback)
              }
            }}
            disabled={isRegenerating}
          >
            <RefreshCw className="h-3 w-3" />
            Regenerate
          </Button>
        )}
      </div>

      {showFeedback && (
        <div className="flex gap-2 ml-6">
          <input
            type="text"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            placeholder="Optional: describe what to change..."
            className="flex-1 text-xs px-2 py-1 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRegenerate(part.tempId, feedbackText || undefined)
                setShowFeedback(false)
                setFeedbackText('')
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => {
              onRegenerate(part.tempId, feedbackText || undefined)
              setShowFeedback(false)
              setFeedbackText('')
            }}
            disabled={isRegenerating}
          >
            Go
          </Button>
        </div>
      )}
    </div>
  )
}

function collectCadParts(node: BomNodeDraft): Array<BomNodeDraft> {
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
