import { useMemo, useState } from 'react'
import {
  Archive,
  CheckCircle2,
  GitBranch,
  GitCommit,
  Lock,
  Tag,
} from 'lucide-react'
import type { VersionContext } from '@/lib/services/VersionResolver'
import type { ComparisonTargets } from '@/lib/services/ThreadComparisonService'
import { cn } from '@/lib/utils'

interface ContextSelectorProps {
  targets: ComparisonTargets
  designId: string
  value: VersionContext | null
  onChange: (context: VersionContext) => void
  label: string
}

type TabType = 'tags' | 'branches' | 'commits'

const tagTypeLabels: Record<string, string> = {
  baseline: 'Baselines',
  release: 'Releases',
  milestone: 'Milestones',
  'eco-release': 'ECO Releases',
}

/**
 * Tabbed context selector for picking tags, branches, or commits
 * for thread comparison.
 */
export function ContextSelector({
  targets,
  designId,
  value,
  onChange,
  label,
}: ContextSelectorProps) {
  const [activeTab, setActiveTab] = useState<TabType>('tags')

  // Group tags by type
  const tagsByType = useMemo(() => {
    const groups: Record<string, typeof targets.tags> = {}
    for (const tag of targets.tags) {
      const type = tag.tagType ?? 'other'
      if (!groups[type]) {
        groups[type] = []
      }
      groups[type].push(tag)
    }
    return groups
  }, [targets.tags])

  // Check if a context matches the current value
  const isSelected = (context: VersionContext): boolean => {
    if (!value) return false
    if (value.type !== context.type) return false

    switch (value.type) {
      case 'released':
        return (
          context.type === 'released' && value.designId === context.designId
        )
      case 'branch':
        return context.type === 'branch' && value.branchId === context.branchId
      case 'commit':
        return context.type === 'commit' && value.commitId === context.commitId
      case 'tag':
        return context.type === 'tag' && value.tagId === context.tagId
      default:
        return false
    }
  }

  return (
    <div className="space-y-3">
      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-300 dark:border-slate-700">
        <button
          type="button"
          onClick={() => setActiveTab('tags')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
            activeTab === 'tags'
              ? 'border-cyan-600 text-cyan-600 font-medium'
              : 'border-transparent text-slate-500 hover:text-slate-700',
          )}
        >
          <Tag className="h-4 w-4" />
          Tags ({targets.tags.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('branches')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
            activeTab === 'branches'
              ? 'border-cyan-600 text-cyan-600 font-medium'
              : 'border-transparent text-slate-500 hover:text-slate-700',
          )}
        >
          <GitBranch className="h-4 w-4" />
          Branches ({targets.branches.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('commits')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
            activeTab === 'commits'
              ? 'border-cyan-600 text-cyan-600 font-medium'
              : 'border-transparent text-slate-500 hover:text-slate-700',
          )}
        >
          <GitCommit className="h-4 w-4" />
          Commits ({targets.recentCommits.length})
        </button>
      </div>

      {/* Tab content */}
      <div className="max-h-64 overflow-y-auto border rounded-lg border-slate-300 dark:border-slate-700">
        {/* Tags tab */}
        {activeTab === 'tags' && (
          <div className="divide-y divide-slate-200 dark:divide-slate-700">
            {/* Released (main) option - always available */}
            <button
              type="button"
              onClick={() => onChange({ type: 'released', designId })}
              className={cn(
                'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                isSelected({ type: 'released', designId })
                  ? 'bg-cyan-50 dark:bg-cyan-950'
                  : 'hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-green-600" />
                <span className="font-medium">Released (main)</span>
              </div>
              {isSelected({ type: 'released', designId }) && (
                <CheckCircle2 className="h-4 w-4 text-cyan-600" />
              )}
            </button>

            {/* Grouped tags */}
            {Object.entries(tagsByType).map(([type, typeTags]) => (
              <div key={type}>
                <div className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 text-xs font-medium text-slate-500 uppercase">
                  {tagTypeLabels[type] ?? type}
                </div>
                {typeTags.map((tag) => {
                  const context: VersionContext = { type: 'tag', tagId: tag.id }
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => onChange(context)}
                      className={cn(
                        'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                        isSelected(context)
                          ? 'bg-cyan-50 dark:bg-cyan-950'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Tag className="h-4 w-4 text-purple-600" />
                        <span>{tag.name}</span>
                        <span className="text-xs text-slate-400">
                          {new Date(tag.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      {isSelected(context) && (
                        <CheckCircle2 className="h-4 w-4 text-cyan-600" />
                      )}
                    </button>
                  )
                })}
              </div>
            ))}

            {targets.tags.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-slate-500">
                No tags available. Use "Released (main)" to compare against the
                current state.
              </div>
            )}
          </div>
        )}

        {/* Branches tab */}
        {activeTab === 'branches' && (
          <div className="divide-y divide-slate-200 dark:divide-slate-700">
            {targets.branches.map((branch) => {
              const context: VersionContext = {
                type: 'branch',
                branchId: branch.id,
              }
              const isMain = branch.branchType === 'main'
              return (
                <button
                  key={branch.id}
                  type="button"
                  onClick={() =>
                    isMain
                      ? onChange({ type: 'released', designId })
                      : onChange(context)
                  }
                  className={cn(
                    'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                    isSelected(
                      isMain ? { type: 'released', designId } : context,
                    )
                      ? 'bg-cyan-50 dark:bg-cyan-950'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                    branch.isArchived && 'opacity-50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <GitBranch
                      className={cn(
                        'h-4 w-4',
                        isMain ? 'text-green-600' : 'text-orange-600',
                      )}
                    />
                    <span className={isMain ? 'font-medium' : ''}>
                      {branch.name}
                    </span>
                    {branch.isLocked && (
                      <Lock className="h-3 w-3 text-amber-500" />
                    )}
                    {branch.isArchived && (
                      <Archive className="h-3 w-3 text-slate-400" />
                    )}
                    <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                      {branch.branchType}
                    </span>
                  </div>
                  {isSelected(
                    isMain ? { type: 'released', designId } : context,
                  ) && <CheckCircle2 className="h-4 w-4 text-cyan-600" />}
                </button>
              )
            })}

            {targets.branches.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-slate-500">
                No branches available.
              </div>
            )}
          </div>
        )}

        {/* Commits tab */}
        {activeTab === 'commits' && (
          <div className="divide-y divide-slate-200 dark:divide-slate-700">
            {targets.recentCommits.map((commit) => {
              const context: VersionContext = {
                type: 'commit',
                commitId: commit.id,
              }
              return (
                <button
                  key={commit.id}
                  type="button"
                  onClick={() => onChange(context)}
                  className={cn(
                    'w-full flex items-center justify-between px-3 py-2 text-left transition-colors',
                    isSelected(context)
                      ? 'bg-cyan-50 dark:bg-cyan-950'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <GitCommit className="h-4 w-4 text-slate-400 flex-shrink-0" />
                      <span className="truncate text-sm">{commit.message}</span>
                    </div>
                    <div className="text-xs text-slate-400 ml-6">
                      {commit.id.slice(0, 8)} &middot;{' '}
                      {new Date(commit.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  {isSelected(context) && (
                    <CheckCircle2 className="h-4 w-4 text-cyan-600 flex-shrink-0" />
                  )}
                </button>
              )
            })}

            {targets.recentCommits.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-slate-500">
                No commits available.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selected value display */}
      {value && (
        <div className="text-xs text-slate-500 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 text-green-600" />
          Selected:{' '}
          <span className="font-medium">
            {value.type === 'released' && 'Released (main)'}
            {value.type === 'branch' &&
              targets.branches.find((b) => b.id === value.branchId)?.name}
            {value.type === 'tag' &&
              targets.tags.find((t) => t.id === value.tagId)?.name}
            {value.type === 'commit' &&
              targets.recentCommits
                .find((c) => c.id === value.commitId)
                ?.message.slice(0, 40)}
          </span>
        </div>
      )}
    </div>
  )
}
