import {
  ArrowRight,
  GitCompare,
  Minus,
  Plus,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import type { ThreadComparisonStats } from '@/lib/services/ThreadComparisonService'
import { cn } from '@/lib/utils'

interface ComparisonSummaryCardsProps {
  stats: ThreadComparisonStats
}

interface CoverageChange {
  before: number
  after: number
}

function CoverageIndicator({
  label,
  change,
}: {
  label: string
  change: CoverageChange
}) {
  const diff = change.after - change.before
  const isPositive = diff > 0
  const isNegative = diff < 0
  const isUnchanged = diff === 0

  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-slate-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">{change.before}%</span>
        <ArrowRight className="h-3 w-3 text-slate-400" />
        <span
          className={cn(
            'text-xs font-medium',
            isPositive && 'text-green-600',
            isNegative && 'text-red-600',
            isUnchanged && 'text-slate-600',
          )}
        >
          {change.after}%
        </span>
        {!isUnchanged && (
          <span
            className={cn(
              'text-xs flex items-center',
              isPositive && 'text-green-600',
              isNegative && 'text-red-600',
            )}
          >
            {isPositive ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {isPositive ? '+' : ''}
            {diff.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Summary cards showing comparison statistics between two thread contexts.
 */
export function ComparisonSummaryCards({ stats }: ComparisonSummaryCardsProps) {
  const hasChanges =
    stats.nodesAdded > 0 ||
    stats.nodesRemoved > 0 ||
    stats.nodesModified > 0 ||
    stats.relationshipsAdded > 0 ||
    stats.relationshipsRemoved > 0 ||
    stats.relationshipsModified > 0

  return (
    <div className="space-y-4">
      {/* Node changes */}
      <div className="grid grid-cols-4 gap-3">
        <div className="p-3 rounded-lg bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800">
          <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
            <Plus className="h-4 w-4" />
            <span className="text-sm font-medium">Added</span>
          </div>
          <p className="text-2xl font-bold text-green-700 dark:text-green-300 mt-1">
            {stats.nodesAdded}
          </p>
          <p className="text-xs text-green-600 dark:text-green-500">nodes</p>
        </div>

        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <Minus className="h-4 w-4" />
            <span className="text-sm font-medium">Removed</span>
          </div>
          <p className="text-2xl font-bold text-red-700 dark:text-red-300 mt-1">
            {stats.nodesRemoved}
          </p>
          <p className="text-xs text-red-600 dark:text-red-500">nodes</p>
        </div>

        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <RefreshCw className="h-4 w-4" />
            <span className="text-sm font-medium">Modified</span>
          </div>
          <p className="text-2xl font-bold text-amber-700 dark:text-amber-300 mt-1">
            {stats.nodesModified}
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-500">
            nodes ({stats.totalFieldChanges} fields)
          </p>
        </div>

        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700">
          <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
            <GitCompare className="h-4 w-4" />
            <span className="text-sm font-medium">Total</span>
          </div>
          <p className="text-2xl font-bold text-slate-700 dark:text-slate-300 mt-1">
            {stats.totalNodes}
          </p>
          <p className="text-xs text-slate-500">
            {stats.nodesUnchanged} unchanged
          </p>
        </div>
      </div>

      {/* Domain breakdown */}
      {hasChanges && (
        <div className="grid grid-cols-4 gap-3">
          {(
            [
              'requirements',
              'engineering',
              'manufacturing',
              'validation',
            ] as const
          ).map((domain) => {
            const domainStats = stats.changesByDomain[domain]
            const hasChangesInDomain =
              domainStats.added > 0 ||
              domainStats.removed > 0 ||
              domainStats.modified > 0

            if (!hasChangesInDomain) return null

            return (
              <div
                key={domain}
                className="p-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              >
                <p className="text-xs font-medium text-slate-500 uppercase mb-1">
                  {domain}
                </p>
                <div className="flex gap-2 text-xs">
                  {domainStats.added > 0 && (
                    <span className="text-green-600">+{domainStats.added}</span>
                  )}
                  {domainStats.removed > 0 && (
                    <span className="text-red-600">-{domainStats.removed}</span>
                  )}
                  {domainStats.modified > 0 && (
                    <span className="text-amber-600">
                      ~{domainStats.modified}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Relationship changes */}
      {(stats.relationshipsAdded > 0 ||
        stats.relationshipsRemoved > 0 ||
        stats.relationshipsModified > 0) && (
        <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            Relationship Changes
          </p>
          <div className="flex gap-4 text-sm">
            {stats.relationshipsAdded > 0 && (
              <span className="text-green-600 flex items-center gap-1">
                <Plus className="h-3 w-3" />
                {stats.relationshipsAdded} added
              </span>
            )}
            {stats.relationshipsRemoved > 0 && (
              <span className="text-red-600 flex items-center gap-1">
                <Minus className="h-3 w-3" />
                {stats.relationshipsRemoved} removed
              </span>
            )}
            {stats.relationshipsModified > 0 && (
              <span className="text-amber-600 flex items-center gap-1">
                <RefreshCw className="h-3 w-3" />
                {stats.relationshipsModified} modified
              </span>
            )}
          </div>
        </div>
      )}

      {/* Coverage changes */}
      <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Coverage Changes
        </p>
        <div className="space-y-1">
          <CoverageIndicator
            label="MBOM Coverage"
            change={stats.coverageChanges.mbomCoverage}
          />
          <CoverageIndicator
            label="Requirements Coverage"
            change={stats.coverageChanges.requirementsCoverage}
          />
          <CoverageIndicator
            label="Test Coverage"
            change={stats.coverageChanges.testCoverage}
          />
        </div>
      </div>

      {/* No changes message */}
      {!hasChanges && (
        <div className="p-4 text-center text-slate-500 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-300 dark:border-slate-700">
          <GitCompare className="h-8 w-8 mx-auto mb-2 text-slate-400" />
          <p className="text-sm">No changes detected between these versions.</p>
          <p className="text-xs text-slate-400 mt-1">
            The digital thread structure is identical.
          </p>
        </div>
      )}
    </div>
  )
}
