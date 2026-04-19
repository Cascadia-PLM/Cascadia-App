import {
  AlertTriangle,
  CheckCircle2,
  Cog,
  Factory,
  FileText,
  FlaskConical,
} from 'lucide-react'
import type {
  GapAnalysisResult,
  GapSeverity,
} from '@/lib/services/GapAnalysisService'
import type { ThreadDomain } from '@/lib/services/ThreadService'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { cn } from '@/lib/utils'

interface GapSummaryCardsProps {
  result: GapAnalysisResult
  className?: string
}

const domainIcons: Record<ThreadDomain, typeof Cog> = {
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

const severityColors: Record<GapSeverity, string> = {
  critical: 'bg-red-600',
  major: 'bg-orange-500',
  minor: 'bg-blue-400',
}

const severityLabels: Record<GapSeverity, string> = {
  critical: 'Critical',
  major: 'Major',
  minor: 'Minor',
}

/**
 * Summary cards showing gap analysis results with completeness score,
 * severity distribution, and domain breakdown.
 */
export function GapSummaryCards({ result, className }: GapSummaryCardsProps) {
  const { summary, coverage } = result
  const domains: Array<ThreadDomain> = [
    'requirements',
    'engineering',
    'manufacturing',
    'validation',
  ]
  const severities: Array<GapSeverity> = ['critical', 'major', 'minor']

  // Calculate total bar width for severity distribution
  const totalSeverity = Object.values(summary.bySeverity).reduce(
    (a, b) => a + b,
    0,
  )

  // Helper to get completeness ring color
  const getCompletenessColor = (value: number) => {
    if (value >= 90) return 'text-green-600'
    if (value >= 70) return 'text-blue-600'
    if (value >= 50) return 'text-orange-500'
    return 'text-red-600'
  }

  // Calculate coverage percentages
  const reqTotal = coverage.requirements.total
  const allocatedPercent =
    reqTotal > 0
      ? Math.round((coverage.requirements.allocated / reqTotal) * 100)
      : 100
  const satisfiedPercent =
    reqTotal > 0
      ? Math.round((coverage.requirements.satisfied / reqTotal) * 100)
      : 100
  const verifiedPercent =
    reqTotal > 0
      ? Math.round((coverage.requirements.verified / reqTotal) * 100)
      : 100
  const testedPercent =
    coverage.engineering.total > 0
      ? Math.round(
          (coverage.engineering.tested / coverage.engineering.total) * 100,
        )
      : 100

  return (
    <div className={cn('space-y-4 w-full max-w-full', className)}>
      {/* Main Overview Card */}
      <Card className="w-full max-w-full overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            {summary.completeness >= 90 ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-orange-500" />
            )}
            Design Completeness
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {/* Completeness Score */}
            <div className="col-span-1 flex flex-col items-center justify-center p-4 rounded-lg bg-slate-50 dark:bg-slate-900">
              <div
                className={cn(
                  'text-4xl font-bold',
                  getCompletenessColor(summary.completeness),
                )}
              >
                {summary.completeness}%
              </div>
              <div className="text-xs text-slate-500 mt-1">Completeness</div>
            </div>

            {/* Severity Counts */}
            <div className="text-center p-3 rounded-lg bg-red-50 dark:bg-red-950">
              <div className="text-2xl font-bold text-red-600">
                {summary.bySeverity.critical}
              </div>
              <div className="text-xs text-slate-500">Critical</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-orange-50 dark:bg-orange-950">
              <div className="text-2xl font-bold text-orange-600">
                {summary.bySeverity.major}
              </div>
              <div className="text-xs text-slate-500">Major</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-blue-50 dark:bg-blue-950">
              <div className="text-2xl font-bold text-blue-600">
                {summary.bySeverity.minor}
              </div>
              <div className="text-xs text-slate-500">Minor</div>
            </div>
            <div className="text-center p-3 rounded-lg bg-slate-100 dark:bg-slate-800">
              <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                {summary.totalGaps}
              </div>
              <div className="text-xs text-slate-500">Total Gaps</div>
            </div>
          </div>

          {/* Severity Distribution Bar */}
          {totalSeverity > 0 && (
            <div className="mt-4">
              <div className="text-xs text-slate-500 mb-1">
                Gap Distribution
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
              <div className="flex flex-wrap gap-4 mt-2 text-xs text-slate-500">
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

      {/* Coverage Metrics Card */}
      <Card className="w-full max-w-full overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Coverage Metrics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 overflow-hidden">
          {/* Requirements Coverage */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium">
                Requirements Allocated
              </span>
              <span className="text-sm text-slate-600">
                {coverage.requirements.allocated}/{coverage.requirements.total}{' '}
                ({allocatedPercent}%)
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
              <div
                className="bg-purple-600 h-2 rounded-full transition-all"
                style={{ width: `${allocatedPercent}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium">
                Requirements Satisfied
              </span>
              <span className="text-sm text-slate-600">
                {coverage.requirements.satisfied}/{coverage.requirements.total}{' '}
                ({satisfiedPercent}%)
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
              <div
                className="bg-cyan-600 h-2 rounded-full transition-all"
                style={{ width: `${satisfiedPercent}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium">Requirements Verified</span>
              <span className="text-sm text-slate-600">
                {coverage.requirements.verified}/{coverage.requirements.total} (
                {verifiedPercent}%)
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
              <div
                className="bg-green-600 h-2 rounded-full transition-all"
                style={{ width: `${verifiedPercent}%` }}
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium">Parts Tested</span>
              <span className="text-sm text-slate-600">
                {coverage.engineering.tested}/{coverage.engineering.total} (
                {testedPercent}%)
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{ width: `${testedPercent}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Domain Cards Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {domains.map((domain) => {
          const Icon = domainIcons[domain]
          const count = summary.byDomain[domain]
          const hasGaps = count > 0

          return (
            <Card
              key={domain}
              className={cn(
                'transition-colors',
                hasGaps
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
                  {count === 1 ? 'gap' : 'gaps'}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
