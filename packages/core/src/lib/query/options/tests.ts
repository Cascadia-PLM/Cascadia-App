// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { ApiData } from '@/lib/api/typed'
import { apiFetch } from '@/lib/api/client'

/** One recorded run of a test case — derived from the OpenAPI contract (FE-7). */
export type TestExecution = ApiData<
  '/api/v1/test-cases/{id}/executions',
  'get'
>['executions'][number]

/** A test case as listed under its parent plan — derived from the contract. */
export type TestPlanTestCase = ApiData<
  '/api/v1/test-plans/{id}/test-cases',
  'get'
>['testCases'][number]

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
