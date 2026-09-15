// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Search,
  Target,
} from 'lucide-react'
import type {
  Gap,
  GapAnalysisResult,
  GapSeverity,
} from '@/lib/services/GapAnalysisService'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { designGapAnalysisQuery } from '@/lib/query'
import { cn } from '@/lib/utils'
import { ItemLink } from '@/components/items/ItemLink'

interface GapAnalysisWidgetProps {
  designId: string
  onRunFullAnalysis?: () => void
  className?: string
}

const severityVariants: Record<
  GapSeverity,
  'destructive' | 'warning' | 'outline'
> = {
  critical: 'destructive',
  major: 'warning',
  minor: 'outline',
}

const severityLabels: Record<GapSeverity, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
}

const gapTypeLabels: Record<string, string> = {
  unallocated_requirement: 'Not Allocated',
  unsatisfied_requirement: 'Not Satisfied',
  unverified_requirement: 'Not Verified',
  untested_part: 'Not Tested',
  unmapped_ebom_item: 'Not Mapped',
  orphan_mbom_item: 'Orphan MBOM',
  missing_documentation: 'Missing Docs',
}

/**
 * Dashboard widget showing design completeness and top gaps.
 * Provides a quick summary of traceability gaps.
 */
export function GapAnalysisWidget({
  designId,
  onRunFullAnalysis,
  className = '',
}: GapAnalysisWidgetProps) {
  const {
    data: result = null,
    isPending: loading,
    error: loadError,
  } = useQuery(designGapAnalysisQuery<GapAnalysisResult>(designId))
  const error = loadError ? 'Failed to load gap analysis' : null

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Design Completeness
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">Loading gap analysis...</p>
        </CardContent>
      </Card>
    )
  }

  if (error || !result) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Design Completeness
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-500">{error || 'No data available'}</p>
        </CardContent>
      </Card>
    )
  }

  const { summary, gaps } = result
  const topGaps = gaps
    .filter((g) => g.severity === 'critical' || g.severity === 'major')
    .slice(0, 5)

  // Helper to get completeness ring color
  const getCompletenessColor = (value: number) => {
    if (value >= 90) return 'text-green-600 dark:text-green-400'
    if (value >= 70) return 'text-blue-600 dark:text-blue-400'
    if (value >= 50) return 'text-orange-500'
    return 'text-red-600 dark:text-red-400'
  }

  const getCompletnessBgColor = (value: number) => {
    if (value >= 90) return 'bg-green-50 dark:bg-green-950'
    if (value >= 70) return 'bg-blue-50 dark:bg-blue-950'
    if (value >= 50) return 'bg-orange-50 dark:bg-orange-950'
    return 'bg-red-50 dark:bg-red-950'
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {summary.completeness >= 90 ? (
            <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
          ) : (
            <Target className="h-5 w-5 text-orange-500" />
          )}
          Design Completeness
        </CardTitle>
        <CardDescription>
          {summary.totalGaps === 0
            ? 'All traceability requirements met'
            : `${summary.totalGaps} traceability gap${summary.totalGaps === 1 ? '' : 's'} identified`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Completeness Score */}
        <div
          className={cn(
            'flex items-center justify-center p-4 rounded-lg',
            getCompletnessBgColor(summary.completeness),
          )}
        >
          <div
            className={cn(
              'text-5xl font-bold',
              getCompletenessColor(summary.completeness),
            )}
          >
            {summary.completeness}%
          </div>
        </div>

        {/* Severity Summary */}
        <div className="grid grid-cols-3 gap-2 py-2 border-t border-b">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              {summary.bySeverity.critical === 0 ? (
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
              ) : (
                <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
              )}
              <span className="text-sm font-medium">
                {summary.bySeverity.critical}
              </span>
            </div>
            <span className="text-xs text-slate-500">Critical</span>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              {summary.bySeverity.major === 0 ? (
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
              ) : (
                <AlertCircle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
              )}
              <span className="text-sm font-medium">
                {summary.bySeverity.major}
              </span>
            </div>
            <span className="text-xs text-slate-500">Major</span>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              <span className="text-sm font-medium">
                {summary.bySeverity.minor}
              </span>
            </div>
            <span className="text-xs text-slate-500">Minor</span>
          </div>
        </div>

        {/* Top Gaps */}
        {topGaps.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
              <AlertCircle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
              Priority Gaps ({topGaps.length})
            </h4>
            <div className="space-y-1 max-h-40 overflow-auto">
              {topGaps.map((gap) => (
                <GapListItem key={gap.id} gap={gap} />
              ))}
              {gaps.length > 5 && (
                <p className="text-xs text-slate-500 text-center py-1">
                  +{gaps.length - 5} more gaps
                </p>
              )}
            </div>
          </div>
        )}

        {/* No Gaps Message */}
        {summary.totalGaps === 0 && (
          <div className="text-center py-4">
            <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400 mx-auto mb-2" />
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Complete traceability coverage
            </p>
          </div>
        )}

        {/* Run Full Analysis Button */}
        {onRunFullAnalysis && (
          <Button
            variant="outline"
            className="w-full"
            onClick={onRunFullAnalysis}
          >
            <Search className="h-4 w-4 mr-2" />
            Run Full Analysis
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Single gap item in the list.
 */
function GapListItem({ gap }: { gap: Gap }) {
  return (
    <ItemLink
      itemType={gap.itemType}
      itemId={gap.itemId}
      className="block p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-900 text-sm"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-cyan-600 dark:text-cyan-400 font-medium">
            {gap.itemNumber}
          </span>
          <Badge variant={severityVariants[gap.severity]} className="text-xs">
            {severityLabels[gap.severity]}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {gapTypeLabels[gap.type] || gap.type}
          </Badge>
          <ChevronRight className="h-3 w-3 text-slate-400" />
        </div>
      </div>
      {gap.itemName && (
        <p className="text-slate-500 text-xs truncate mt-0.5">{gap.itemName}</p>
      )}
    </ItemLink>
  )
}
