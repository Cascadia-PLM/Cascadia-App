import { Plus, Tag } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

interface TagItem {
  id: string
  name: string
  tagType: string
  description?: string
  createdAt: string
}

interface QuickJumpPillsProps {
  tags: Array<TagItem>
  currentTagId?: string
  onTagClick: (tagId: string, tagName: string) => void
  onCreateTag?: () => void
  maxVisible?: number
  className?: string
}

export function QuickJumpPills({
  tags,
  currentTagId,
  onTagClick,
  onCreateTag,
  maxVisible = 5,
  className,
}: QuickJumpPillsProps) {
  // Sort by creation date (newest first) and take the most recent
  const recentTags = [...tags]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, maxVisible)

  if (recentTags.length === 0 && !onCreateTag) {
    return null
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="text-sm text-slate-500 dark:text-slate-400 mr-1">
        Quick Jump:
      </span>

      {recentTags.map((tag) => (
        <button
          key={tag.id}
          onClick={() => onTagClick(tag.id, tag.name)}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
            'border hover:border-cyan-500 hover:text-cyan-600 dark:hover:text-cyan-400',
            currentTagId === tag.id
              ? 'bg-cyan-50 border-cyan-500 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300'
              : 'bg-white border-slate-300 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300',
          )}
        >
          <Tag className="h-3 w-3" />
          {tag.name}
          {tag.description && (
            <span className="text-slate-400 dark:text-slate-500 font-normal ml-1 hidden sm:inline">
              {tag.description.length > 20
                ? `${tag.description.slice(0, 20)}...`
                : tag.description}
            </span>
          )}
        </button>
      ))}

      {onCreateTag && (
        <Button
          variant="outline"
          size="sm"
          onClick={onCreateTag}
          className="rounded-full"
        >
          <Plus className="h-3 w-3 mr-1" />
          Create Tag
        </Button>
      )}
    </div>
  )
}
