/**
 * ItemCommentThread - Per-item feedback thread for a requirement or BOM node.
 *
 * Renders a comment-count toggle; expanded, it lists the item's comments with
 * resolve toggles and an input for new comments. Unresolved comments are
 * injected into the next AI run for that artifact.
 */

import { useState } from 'react'
import { Check, MessageSquare, RotateCcw, X } from 'lucide-react'
import type { ItemComment } from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

interface ItemCommentThreadProps {
  targetType: ItemComment['targetType']
  targetTempId: string
  comments: Array<ItemComment>
  canComment: boolean
  onAddComment?: (
    targetType: ItemComment['targetType'],
    targetTempId: string,
    text: string,
  ) => void
  onSetResolved?: (commentId: string, resolved: boolean) => void
  className?: string
}

export function ItemCommentThread({
  targetType,
  targetTempId,
  comments,
  canComment,
  onAddComment,
  onSetResolved,
  className,
}: ItemCommentThreadProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const itemComments = comments.filter(
    (c) => c.targetType === targetType && c.targetTempId === targetTempId,
  )
  const unresolvedCount = itemComments.filter((c) => !c.resolved).length

  if (!onAddComment && itemComments.length === 0) return null

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    onAddComment?.(targetType, targetTempId, text)
    setDraft('')
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-1 text-[10px] rounded px-1 py-0.5',
          unresolvedCount > 0
            ? 'text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30'
            : 'text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
        )}
        title={
          itemComments.length > 0
            ? `${itemComments.length} comment(s), ${unresolvedCount} unresolved`
            : 'Add a comment for the AI'
        }
      >
        <MessageSquare className="h-3 w-3" />
        {itemComments.length > 0 && itemComments.length}
      </button>

      {open && (
        <div className="mt-1 space-y-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 p-2">
          {itemComments.map((comment) => (
            <div key={comment.id} className="flex items-start gap-1.5">
              <p
                className={cn(
                  'flex-1 text-[11px] text-slate-600 dark:text-slate-300',
                  comment.resolved &&
                    'line-through text-slate-400 dark:text-slate-500',
                )}
              >
                {comment.text}
              </p>
              {onSetResolved && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onSetResolved(comment.id, !comment.resolved)}
                  className="h-5 w-5 p-0 flex-shrink-0"
                  title={
                    comment.resolved ? 'Reopen comment' : 'Mark as resolved'
                  }
                >
                  {comment.resolved ? (
                    <RotateCcw className="h-2.5 w-2.5" />
                  ) : (
                    <Check className="h-2.5 w-2.5" />
                  )}
                </Button>
              )}
            </div>
          ))}
          {itemComments.length === 0 && (
            <p className="text-[10px] text-slate-400 dark:text-slate-500">
              No comments yet — unresolved comments are addressed by the AI on
              its next run.
            </p>
          )}
          {canComment && onAddComment && (
            <div className="flex items-center gap-1">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="h-6 text-[11px] flex-1"
                placeholder="Comment for the AI…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit()
                  if (e.key === 'Escape') setOpen(false)
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={submit}
                disabled={!draft.trim()}
                className="h-6 w-6 p-0"
                title="Add comment"
              >
                <Check className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOpen(false)}
                className="h-6 w-6 p-0"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
