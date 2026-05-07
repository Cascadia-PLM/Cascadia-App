import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  XCircle,
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

interface VerificationGap {
  id: string
  itemNumber: string
  name: string | null
  priority: string | null
}

interface TestCoverage {
  totalRequirements: number
  requirementsWithTests: number
  coveragePercent: number
  totalTests: number
  passed: number
  failed: number
  blocked: number
  notRun: number
  passedPercent: number
  failedPercent: number
}

interface TestCoverageWidgetProps {
  designId: string
  className?: string
}

/**
 * Widget showing test coverage metrics for a design.
 * Shows % of requirements with tests and test execution results.
 */
export function TestCoverageWidget({
  designId,
  className = '',
}: TestCoverageWidgetProps) {
  const [coverage, setCoverage] = useState<TestCoverage | null>(null)
  const [gaps, setGaps] = useState<Array<VerificationGap>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      setError(null)
      try {
        // Fetch coverage and gaps in parallel
        const [coverageResponse, gapsResponse] = await Promise.all([
          apiFetch<{ data: { coverage: TestCoverage } }>(
            `/api/designs/${designId}/test-coverage`,
          ),
          apiFetch<{ data: { gaps: Array<VerificationGap> } }>(
            `/api/designs/${designId}/verification-gaps`,
          ),
        ])
        setCoverage(coverageResponse.data.coverage)
        setGaps(gapsResponse.data.gaps)
      } catch (err) {
        setError('Failed to load test coverage data')
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [designId])

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5" />
            Test Coverage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">Loading test coverage...</p>
        </CardContent>
      </Card>
    )
  }

  if (error || !coverage) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5" />
            Test Coverage
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
            <FlaskConical className="h-5 w-5" />
            Test Coverage
          </CardTitle>
          <CardDescription>
            Track test case coverage for requirements
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <p className="text-slate-500">No requirements to test yet</p>
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

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5" />
          Test Coverage
        </CardTitle>
        <CardDescription>
          {coverage.totalTests} test cases for {coverage.totalRequirements}{' '}
          requirements
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Requirements Coverage */}
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-sm font-medium">Requirements with Tests</span>
            <span className="text-sm text-slate-600">
              {coverage.requirementsWithTests}/{coverage.totalRequirements} (
              {coverage.coveragePercent}%)
            </span>
          </div>
          <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5">
            <div
              className="bg-purple-600 h-2.5 rounded-full transition-all"
              style={{ width: `${coverage.coveragePercent}%` }}
            />
          </div>
        </div>

        {/* Test Execution Summary */}
        {coverage.totalTests > 0 && (
          <div className="grid grid-cols-4 gap-2 py-3 border-t border-b">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-lg font-bold text-green-600">
                  {coverage.passed}
                </span>
              </div>
              <span className="text-xs text-slate-500">Passed</span>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1">
                <XCircle className="h-4 w-4 text-red-600" />
                <span className="text-lg font-bold text-red-600">
                  {coverage.failed}
                </span>
              </div>
              <span className="text-xs text-slate-500">Failed</span>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1">
                <AlertCircle className="h-4 w-4 text-yellow-600" />
                <span className="text-lg font-bold text-yellow-600">
                  {coverage.blocked}
                </span>
              </div>
              <span className="text-xs text-slate-500">Blocked</span>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1">
                <div className="h-4 w-4 rounded-full bg-slate-300" />
                <span className="text-lg font-bold text-slate-500">
                  {coverage.notRun}
                </span>
              </div>
              <span className="text-xs text-slate-500">Not Run</span>
            </div>
          </div>
        )}

        {/* Pass/Fail Rate Bar */}
        {coverage.totalTests > 0 && (
          <div>
            <div className="flex justify-between mb-1">
              <span className="text-sm font-medium">Pass Rate</span>
              <span className="text-sm text-slate-600">
                {coverage.passedPercent}%
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2.5 flex overflow-hidden">
              <div
                className="bg-green-600 h-2.5"
                style={{ width: `${coverage.passedPercent}%` }}
              />
              <div
                className="bg-red-600 h-2.5"
                style={{ width: `${coverage.failedPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Verification Gaps */}
        {gaps.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-1">
              <AlertCircle className="h-4 w-4 text-orange-600" />
              Requirements without Tests ({gaps.length})
            </h4>
            <div className="space-y-1 max-h-40 overflow-auto">
              {gaps.slice(0, 5).map((gap) => (
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
                    <ExternalLink className="h-3 w-3 text-slate-400" />
                  </div>
                  {gap.name && (
                    <p className="text-slate-500 text-xs truncate mt-0.5">
                      {gap.name}
                    </p>
                  )}
                </Link>
              ))}
              {gaps.length > 5 && (
                <p className="text-xs text-slate-500 text-center py-1">
                  +{gaps.length - 5} more requirements without tests
                </p>
              )}
            </div>
          </div>
        )}

        {/* View All Link */}
        <Link
          to="/test-cases"
          className="flex items-center justify-center gap-1 text-sm text-purple-600 hover:text-purple-700"
        >
          View All Test Cases
          <ChevronRight className="h-4 w-4" />
        </Link>
      </CardContent>
    </Card>
  )
}
