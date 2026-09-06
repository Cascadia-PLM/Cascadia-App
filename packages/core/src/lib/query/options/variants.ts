// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/**
 * Product variants, read side. Keyed beneath the part, so
 * `invalidate('parts')` (which `relationships` fans out to) refreshes them.
 */

export interface VariantLintFinding {
  code: string
  severity: 'error' | 'warning'
  message: string
  relationshipId?: string
  makeCode?: string
  family?: string
  value?: string
}

export function partVariantLintQuery(
  partId: string,
  branchId?: string,
  enabled = true,
) {
  const search = branchId ? `?branchId=${branchId}` : ''
  return queryOptions({
    queryKey: qk.sub('parts', partId, 'variants-lint', { branchId }),
    queryFn: async (): Promise<Array<VariantLintFinding>> => {
      const result = await apiFetch<{
        data: { findings: Array<VariantLintFinding> }
      }>(`/api/v1/parts/${partId}/variants/lint${search}`)
      return result.data.findings
    },
    enabled: enabled && Boolean(partId),
  })
}

export interface SelectionIssue {
  severity: 'error' | 'warning'
  family?: string
  message: string
}

export interface SelectionValidation {
  valid: boolean
  errors: Array<SelectionIssue>
  warnings: Array<SelectionIssue>
}

export function partVariantValidateQuery(
  partId: string,
  selections: Record<string, string>,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('parts', partId, 'variants-validate', selections),
    queryFn: async (): Promise<SelectionValidation> => {
      const result = await apiFetch<{ data: SelectionValidation }>(
        `/api/v1/parts/${partId}/variants/validate`,
        { method: 'POST', body: JSON.stringify({ selections }) },
      )
      return result.data
    },
    enabled: enabled && Boolean(partId),
  })
}

export interface ResolvedBomNode {
  itemId: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  designId: string | null
  relationshipId: string
  quantity: number | null
  findNumber: number | null
  referenceDesignator: string | null
  admittedBy: { all: Array<{ family: string; values: Array<string> }> } | null
  children: Array<ResolvedBomNode>
}

export interface ResolvedBom {
  root: {
    itemId: string
    itemNumber: string
    name: string | null
    revision: string
  }
  selections: Record<string, string>
  validation: SelectionValidation
  children: Array<ResolvedBomNode>
  droppedLines: number
  findings: Array<{ itemNumber: string; message: string }>
}

export function partVariantResolveQuery(
  partId: string,
  selections: Record<string, string>,
  branchId?: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.sub('parts', partId, 'variants-resolve', {
      selections,
      branchId,
    }),
    queryFn: async (): Promise<ResolvedBom> => {
      const result = await apiFetch<{ data: ResolvedBom }>(
        `/api/v1/parts/${partId}/variants/resolve`,
        { method: 'POST', body: JSON.stringify({ selections, branchId }) },
      )
      return result.data
    },
    enabled: enabled && Boolean(partId),
  })
}
