import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Cog,
  Factory,
  FileText,
  FlaskConical,
} from 'lucide-react'
import type {
  ImpactAnalysisResult,
  ImpactSeverity,
} from '@/lib/services/ImpactAnalysisService'
import type { ThreadDomain } from '@/lib/services/ThreadService'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { cn } from '@/lib/utils'

interface ImpactSummaryCardsProps {
  result: ImpactAnalysisResult
  className?: string
}

const domainIcons: Record<ThreadDomain, typeof Box> = {
  requirements: FileText,
  engineering: Cog,
  manufacturing: Factory,
  validation: FlaskConical,
}

const domainLabels: Record<ThreadDomain, string> = {
  requirements: 'Requirements',
  engineering: 'Engineering',
  manufacturing: 'Manufacturing',
  validation: 'Validation',
}

const domainColors: Record<ThreadDomain, string> = {
  requirements: 'text-purple-600 bg-purple-50 dark:bg-purple-950',
  engineering: 'text-blue-600 bg-blue-50 dark:bg-blue-950',
  manufacturing: 'text-orange-600 bg-orange-50 dark:bg-orange-950',
  validation: 'text-green-600 bg-green-50 dark:bg-green-950',
}

const severityColors: Record<ImpactSeverity, string> = {
  critical: 'bg-red-600',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-400',
}

const severityLabels: Record<ImpactSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

/**
 * Summary cards showing impact analysis results by domain and severity.
 */
export function ImpactSummaryCards({
  result,
  className,
}: ImpactSummaryCardsProps) {
  const { summary, recommendations } = result
  const domains: Array<ThreadDomain> = [
    'requirements',
    'engineering',
    'manufacturing',
    'validation',
  ]
  const severities: Array<ImpactSeverity> = [
    'critical',
    'high',
    'medium',
    'low',
  ]

  // Calculate total bar width for severity distribution
  const totalSeverity = Object.values(summary.bySeverity).reduce(
    (a, b) => a + b,
    0,
  )

  return (
    <div className={cn('space-y-4 w-full max-w-full', className)}>
      {/* Overview Card */}
      <Card className="w-full max-w-full overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-orange-500" />
            Impact Overview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="text-center p-3 rounded-lg bg-slate-50 dark:bg-slate-900">
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                {summary.totalImpacted}
              </div>
              <div className="text-xs text-slate-500">Total Impacted</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-red-50 dark:bg-red-950">
              <div className="text-2xl font-bold text-red-600">
                {summary.bySeverity.critical}
              </div>
              <div className="text-xs text-slate-500">Critical</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-orange-50 dark:bg-orange-950">
              <div className="text-2xl font-bold text-orange-600">
                {summary.bySeverity.high}
              </div>
              <div className="text-xs text-slate-500">High</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-blue-50 dark:bg-blue-950">
              <div className="text-2xl font-bold text-blue-600">
                {summary.crossDesignCount}
              </div>
              <div className="text-xs text-slate-500">Cross-Design</div>
            </div>
          </div>

          {/* Severity Distribution Bar */}
          {totalSeverity > 0 && (
            <div className="mt-4">
              <div className="text-xs text-slate-500 mb-1">
                Severity Distribution
              </div>
              <div className="h-3 rounded-full overflow-hidden flex bg-slate-100 dark:bg-slate-800">
                {severities.map((severity) => {
                  const count = summary.bySeverity[severity]
                  if (count === 0) return null
                  const width = (count / totalSeverity) * 100
                  return (
                    <div
                      key={severity}
                      className={cn(severityColors[severity], 'transition-all')}
                      style={{ width: `${width}%` }}
                      title={`${severityLabels[severity]}: ${count}`}
                    />
                  )
                })}
              </div>
              <div className="flex gap-4 mt-2 text-xs text-slate-500">
                {severities.map((severity) => {
                  const count = summary.bySeverity[severity]
                  if (count === 0) return null
                  return (
                    <div key={severity} className="flex items-center gap-1">
                      <div
                        className={cn(
                          'w-2 h-2 rounded-full',
                          severityColors[severity],
                        )}
                      />
                      <span>
                        {severityLabels[severity]}: {count}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Domain Cards Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {domains.map((domain) => {
          const Icon = domainIcons[domain]
          const count = summary.byDomain[domain]
          const hasItems = count > 0

          return (
            <Card
              key={domain}
              className={cn(
                'transition-colors',
                hasItems
                  ? domainColors[domain]
                  : 'bg-slate-50 dark:bg-slate-900 text-slate-400',
              )}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Icon className="h-4 w-4" />
                  <span className="text-sm font-medium">
                    {domainLabels[domain]}
                  </span>
                </div>
                <div className="text-3xl font-bold">{count}</div>
                <div className="text-xs opacity-70">
                  {count === 1 ? 'item impacted' : 'items impacted'}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Recommendations Card */}
      {recommendations.length > 0 && (
        <Card className="w-full max-w-full overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg text-slate-900 dark:text-slate-100">
              Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {recommendations.map((rec, index) => {
                const isWarning =
                  rec.toLowerCase().includes('critical') ||
                  rec.toLowerCase().includes('coordinate') ||
                  rec.toLowerCase().includes('review')
                const isSuccess = rec.toLowerCase().includes('no critical')

                return (
                  <li
                    key={index}
                    className={cn(
                      'flex items-start gap-2 text-sm',
                      isWarning && 'text-orange-600 dark:text-orange-400',
                      isSuccess && 'text-green-600 dark:text-green-400',
                    )}
                  >
                    {isSuccess ? (
                      <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    ) : isWarning ? (
                      <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    ) : (
                      <Box className="h-4 w-4 mt-0.5 flex-shrink-0 text-slate-400" />
                    )}
                    <span>{rec}</span>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
