// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/** One recorded run of a test case. */
export interface TestExecution {
  id: string
  testCaseId: string
  executorId: string
  executorName?: string
  executedAt: string
  status: 'Passed' | 'Failed' | 'Blocked'
  duration?: number
  environment?: string
  actualResults?: string
  notes?: string
}

/** A test case as listed under its parent plan. */
export interface TestPlanTestCase {
  id: string
  itemNumber: string
  name: string | null
  state: string
  testType: string | null
  executionStatus: string | null
  lastExecutedAt: string | null
}

/**
 * Execution history for one test case.
 *
 * Keyed beneath the test case, so recording a run — which invalidates
 * `test-cases` — refreshes the history without the caller refetching by hand.
 */
export function testCaseExecutionsQuery(testCaseId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('test-cases', testCaseId, 'executions'),
    queryFn: async (): Promise<Array<TestExecution>> => {
      const result = await apiFetch<{
        data: { executions: Array<TestExecution> }
      }>(`/api/v1/test-cases/${testCaseId}/executions`)
      return result.data.executions
    },
    enabled,
  })
}

/**
 * The test cases belonging to a test plan.
 *
 * Parentage is a column on `test_cases`, not a relationship edge, so this
 * reads from the plan's own endpoint rather than the relationships API.
 */
export function testPlanTestCasesQuery(testPlanId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('test-plans', testPlanId, 'test-cases'),
    queryFn: async (): Promise<Array<TestPlanTestCase>> => {
      const result = await apiFetch<{
        data: { testCases: Array<TestPlanTestCase> }
      }>(`/api/v1/test-plans/${testPlanId}/test-cases`)
      return result.data.testCases
    },
    enabled,
  })
}
