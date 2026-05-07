import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Target,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface RequirementGap {
  id: string
  itemNumber: string
  name: string | null
  priority: string | null
  gapType: 'not_allocated' | 'not_satisfied' | 'not_verified'
}

interface RequirementsCoverage {
  totalRequirements: number
  allocated: number
  satisfied: number
  verified: number
  allocatedPercent: number
  satisfiedPercent: number
  verifiedPercent: number
  gaps: Array<RequirementGap>
}

interface RequirementsCoverageWidgetProps {
  designId: string
  className?: string
}

/**
 * Donut chart showing requirements coverage metrics for a design.
 * Shows allocated, satisfied, and verified percentages.
 */
export function RequirementsCoverageWidget({
  designId,
  className = '',
}: RequirementsCoverageWidgetProps) {
  const [coverage, setCoverage] = useState<RequirementsCoverage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchCoverage() {
      setLoading(true)
      setError(null)
      try {
        const response = await apiFetch<{ data: RequirementsCoverage }>(
          `/api/v1/designs/${designId}/requirements-coverage`,
        )
        setCoverage(response.data)
      } catch (err) {
        setError('Failed to load coverage data')
      } finally {
        setLoading(false)
      }
    }
    fetchCoverage()
  }, [designId])

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Requirements Coverage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">Loading coverage data...</p>
        </CardContent>
      </Card>
    )
  }

  if (error || !coverage) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Requirements Coverage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-500">{error || 'No data available'}</p>
        </CardContent>
      </Card>
    )
  }

  if (coverage.totalRequirements === 0) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Requirements Coverage
          </CardTitle>
          <CardDescription>
            Track requirements allocation, satisfaction, and verification
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <p className="text-slate-500">No requirements defined yet</p>
            <Link to="/requirements/new">
              <Button variant="outline" size="sm" className="mt-3">
                Add First Requirement
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    )
  }

  const priorityColor = (priority: string | null) => {
    switch (priority) {
      case 'MustHave':
        return 'text-red-600'
      case 'ShouldHave':
        return 'text-orange-600'
      case 'CouldHave':
        return 'text-blue-600'
      default:
        return 'text-slate-600'
    }
  }

  const gapTypeLabel = (gapType: string) => {
    switch (gapType) {
      case 'not_allocated':
        return 'Not Allocated'
      case 'not_satisfied':
        return 'Not Satisfied'
      case 'not_verified':
        return 'Not Verified'
      default:
        return gapType
    }
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5" />
          Requirements Coverage
        </CardTitle>
        <CardDescription>
          {coverage.totalRequirements} requirements tracked
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Coverage Bars */}
        <div className="space-y-4">
          {/* Allocated */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium">Allocated</span>
              <span className="text-sm text-slate-600">
                {coverage.allocated}/{coverage.totalRequirements} (
                {coverage.allocatedPercent}%)
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-all"
                style={{ width: `${coverage.allocatedPercent}%` }}
              />
            </div>
          </div>

          {/* Satisfied */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium">Satisfied</span>
              <span className="text-sm text-slate-600">
                {coverage.satisfied}/{coverage.totalRequirements} (
                {coverage.satisfiedPercent}%)
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5">
              <div
                className="bg-cyan-600 h-2.5 rounded-full transition-all"
                style={{ width: `${coverage.satisfiedPercent}%` }}
              />
            </div>
          </div>

          {/* Verified */}
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium">Verified</span>
              <span className="text-sm text-slate-600">
                {coverage.verified}/{coverage.totalRequirements} (
                {coverage.verifiedPercent}%)
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5">
              <div
                className="bg-green-600 h-2.5 rounded-full transition-all"
                style={{ width: `${coverage.verifiedPercent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Status Summary */}
        <div className="grid grid-cols-3 gap-2 py-2 border-t border-b">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              {coverage.allocatedPercent === 100 ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-orange-600" />
              )}
              <span className="text-sm font-medium">
                {coverage.allocatedPercent}%
              </span>
            </div>
            <span className="text-xs text-slate-500">Allocated</span>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              {coverage.satisfiedPercent === 100 ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-orange-600" />
              )}
              <span className="text-sm font-medium">
                {coverage.satisfiedPercent}%
              </span>
            </div>
            <span className="text-xs text-slate-500">Satisfied</span>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1">
              {coverage.verifiedPercent === 100 ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <AlertCircle className="h-4 w-4 text-orange-600" />
              )}
              <span className="text-sm font-medium">
                {coverage.verifiedPercent}%
              </span>
            </div>
            <span className="text-xs text-slate-500">Verified</span>
          </div>
        </div>

        {/* Gaps */}
        {coverage.gaps.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
              <AlertCircle className="h-4 w-4 text-orange-600" />
              Coverage Gaps ({coverage.gaps.length})
            </h4>
            <div className="space-y-1 max-h-40 overflow-auto">
              {coverage.gaps.slice(0, 5).map((gap) => (
                <Link
                  key={gap.id}
                  to={`/requirements/${gap.id}` as any}
                  className="block p-2 rounded hover:bg-slate-50 dark:hover:bg-slate-900 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={priorityColor(gap.priority)}>
                        {gap.itemNumber}
                      </span>
                      {gap.priority && (
                        <Badge
                          variant={
                            gap.priority === 'MustHave'
                              ? 'destructive'
                              : 'secondary'
                          }
                          className="text-xs"
                        >
                          {gap.priority}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {gapTypeLabel(gap.gapType)}
                      </Badge>
                      <ExternalLink className="h-3 w-3 text-slate-400" />
                    </div>
                  </div>
                  {gap.name && (
                    <p className="text-slate-500 text-xs truncate mt-0.5">
                      {gap.name}
                    </p>
                  )}
                </Link>
              ))}
              {coverage.gaps.length > 5 && (
                <p className="text-xs text-slate-500 text-center py-1">
                  +{coverage.gaps.length - 5} more gaps
                </p>
              )}
            </div>
          </div>
        )}

        {/* View All Link */}
        <Link
          to="/requirements"
          className="flex items-center justify-center gap-1 text-sm text-cyan-600 hover:text-cyan-700"
        >
          View All Requirements
          <ChevronRight className="h-4 w-4" />
        </Link>
      </CardContent>
    </Card>
  )
}
