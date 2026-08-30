// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  CheckCircle2,
  Loader2,
  Plus,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react'
import type { TestCase } from '@/lib/items/types/testcase'
import { apiFetch } from '@/lib/api/client'
import {
  entitySubQuery,
  itemCollectionQuery,
  useInvalidateResources,
} from '@/lib/query'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@/components/ui'

interface VerifyingTest extends TestCase {
  executionStatus?: 'NotRun' | 'Passed' | 'Failed' | 'Blocked'
}

/** The server's reason if it gave one, else a generic fallback. */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

interface RequirementVerificationPanelProps {
  requirementId: string
  designId?: string
  isEditable?: boolean
}

export function RequirementVerificationPanel({
  requirementId,
  designId,
  isEditable = false,
}: RequirementVerificationPanelProps) {
  const { alert } = useAlertDialog()
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [linking, setLinking] = useState<string | null>(null)
  const [unlinking, setUnlinking] = useState<string | null>(null)
  const invalidate = useInvalidateResources()

  // The tests that verify this requirement
  const { data: verifyingTests = [], isPending: loading } = useQuery(
    entitySubQuery<VerifyingTest>(
      'requirements',
      requirementId,
      'verifying-tests',
      'tests',
    ),
  )

  // Candidate test cases in the same design, minus the ones already linked.
  const debouncedSearch = useDebouncedValue(searchQuery)
  const { data: candidates = [], isFetching: searching } = useQuery({
    ...itemCollectionQuery<TestCase>({
      itemType: 'TestCase',
      designId,
      search: debouncedSearch,
    }),
    enabled: Boolean(debouncedSearch.trim()) && Boolean(designId),
  })
  const linkedIds = new Set(verifyingTests.map((t) => t.id))
  const searchResults = debouncedSearch.trim()
    ? candidates.filter((tc) => !linkedIds.has(tc.id))
    : []

  const handleLinkTest = async (testCaseId: string) => {
    setLinking(testCaseId)
    try {
      await apiFetch(`/api/v1/requirements/${requirementId}/verify`, {
        method: 'POST',
        body: JSON.stringify({ testCaseIds: [testCaseId] }),
      })
      await invalidate('requirements')
      setSearchQuery('')
    } catch (error) {
      // A released requirement is not editable outside a change order, so
      // this legitimately refuses. Silently dropping it left the user
      // clicking + with nothing happening and no reason given.
      alert({
        title: 'Could not link test case',
        description: errorMessage(
          error,
          'The verification link could not be recorded.',
        ),
        variant: 'destructive',
      })
    } finally {
      setLinking(null)
    }
  }

  const handleUnlinkTest = async (testCaseId: string) => {
    setUnlinking(testCaseId)
    try {
      await apiFetch(
        `/api/v1/requirements/${requirementId}/verify?testCaseId=${testCaseId}`,
        { method: 'DELETE' },
      )
      await invalidate('requirements')
    } catch (error) {
      alert({
        title: 'Could not remove test case',
        description: errorMessage(
          error,
          'The verification link could not be removed.',
        ),
        variant: 'destructive',
      })
    } finally {
      setUnlinking(null)
    }
  }

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case 'Passed':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />
      case 'Failed':
        return <XCircle className="h-4 w-4 text-red-500" />
      case 'Blocked':
        return <div className="h-4 w-4 rounded-full bg-yellow-500" />
      default:
        return (
          <div className="h-4 w-4 rounded-full bg-slate-300 dark:bg-slate-600" />
        )
    }
  }

  const getStatusVariant = (status?: string) => {
    switch (status) {
      case 'Passed':
        return 'success'
      case 'Failed':
        return 'destructive'
      case 'Blocked':
        return 'warning'
      default:
        return 'secondary'
    }
  }

  // Calculate summary
  const summary = {
    total: verifyingTests.length,
    passed: verifyingTests.filter((t) => t.executionStatus === 'Passed').length,
    failed: verifyingTests.filter((t) => t.executionStatus === 'Failed').length,
    blocked: verifyingTests.filter((t) => t.executionStatus === 'Blocked')
      .length,
    notRun: verifyingTests.filter(
      (t) => !t.executionStatus || t.executionStatus === 'NotRun',
    ).length,
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Verification</CardTitle>
            <CardDescription>
              Test cases that verify this requirement
            </CardDescription>
          </div>
          {isEditable && !showSearch && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSearch(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              Link Test
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        {verifyingTests.length > 0 && (
          <div className="flex gap-4 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
            <div className="text-center">
              <div className="text-xl font-bold">{summary.total}</div>
              <div className="text-xs text-slate-500">Total</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-green-600 dark:text-green-400">
                {summary.passed}
              </div>
              <div className="text-xs text-slate-500">Passed</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-red-600 dark:text-red-400">
                {summary.failed}
              </div>
              <div className="text-xs text-slate-500">Failed</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-yellow-600 dark:text-yellow-400">
                {summary.blocked}
              </div>
              <div className="text-xs text-slate-500">Blocked</div>
            </div>
            <div className="text-center">
              <div className="text-xl font-bold text-slate-400">
                {summary.notRun}
              </div>
              <div className="text-xs text-slate-500">Not Run</div>
            </div>
          </div>
        )}

        {/* Search */}
        {showSearch && isEditable && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search for test cases to link..."
                className="pl-10"
              />
              {searching && (
                <Loader2 className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 animate-spin text-slate-400" />
              )}
            </div>
            {searchResults.length > 0 && (
              <div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
                {searchResults.map((tc) => (
                  <div
                    key={tc.id}
                    className="flex items-center justify-between p-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <div>
                      <span className="font-mono text-sm">{tc.itemNumber}</span>
                      <span className="ml-2 text-slate-600 dark:text-slate-400">
                        {tc.name}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleLinkTest(tc.id!)}
                      disabled={linking === tc.id}
                    >
                      {linking === tc.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowSearch(false)
                  setSearchQuery('')
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Test list */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        ) : verifyingTests.length === 0 ? (
          <div className="text-center py-8 text-slate-500">
            No test cases linked to this requirement
          </div>
        ) : (
          <div className="space-y-2">
            {verifyingTests.map((test) => (
              <div
                key={test.id}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <Link
                  to="/test-cases/$id"
                  params={{ id: test.id! }}
                  className="flex items-center gap-3 flex-grow"
                >
                  {getStatusIcon(test.executionStatus)}
                  <span className="font-mono text-sm">{test.itemNumber}</span>
                  <span className="text-slate-600 dark:text-slate-400">
                    {test.name}
                  </span>
                  <Badge
                    variant={getStatusVariant(test.executionStatus) as any}
                  >
                    {test.executionStatus || 'Not Run'}
                  </Badge>
                </Link>
                {isEditable && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleUnlinkTest(test.id!)}
                    disabled={unlinking === test.id}
                    className="text-slate-400 hover:text-red-500"
                  >
                    {unlinking === test.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
