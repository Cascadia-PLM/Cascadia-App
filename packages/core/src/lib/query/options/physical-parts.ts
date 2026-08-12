// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { entityQuery, entitySubQuery } from './entities'
import { apiFetch } from '@/lib/api/client'

export interface PhysicalPartRow {
  id: string
  itemNumber: string
  name: string | null
  state: string
  instanceKind: 'unit' | 'lot'
  serialNumber: string | null
  lotNumber: string | null
  partItemNumber: string | null
  partName: string | null
}

export interface PhysicalPartDetail extends PhysicalPartRow {
  partMasterId: string
  manufacturerPartId: string | null
  asBuiltItemId: string | null
  producingWorkOrderId: string | null
  erpRef: string | null
  notes: string | null
}

export interface PhysicalPartSearch {
  q?: string
  kind?: 'all' | 'unit' | 'lot'
}

/**
 * Physical instances matching a search.
 *
 * Params are normalised here so the empty search a loader primes and the
 * empty search the page starts with build the same key — one fetch, no
 * loading flash.
 */
export function physicalPartListQuery(search: PhysicalPartSearch = {}) {
  const q = search.q?.trim() ?? ''
  const kind = search.kind ?? 'all'
  return queryOptions({
    queryKey: qk.list('physical-parts', { q, kind }),
    queryFn: async (): Promise<Array<PhysicalPartRow>> => {
      const qs = new URLSearchParams()
      if (q) qs.set('q', q)
      if (kind !== 'all') qs.set('kind', kind)
      const suffix = qs.size > 0 ? `?${qs}` : ''
      const result = await apiFetch<{
        data: { physicalParts: Array<PhysicalPartRow> }
      }>(`/api/v1/physical-parts${suffix}`)
      return result.data.physicalParts
    },
  })
}

export function physicalPartDetailQuery(id: string) {
  return entityQuery<PhysicalPartDetail>('physical-parts', id, 'physicalPart')
}

export interface PhysicalPartEvidenceLink {
  edgeId: string
  requirementItemId: string
  requirementNumber: string
  requirementName: string | null
  note: string | null
}

/** Requirements this instance's certifications are asserted to satisfy. */
export function physicalPartEvidenceQuery(id: string) {
  return entitySubQuery<PhysicalPartEvidenceLink>(
    'physical-parts',
    id,
    'evidence',
    'evidence',
  )
}

export interface GenealogyNode {
  itemId: string
  kind: 'unit' | 'lot' | 'bulk'
  physicalPartNumber: string | null
  serialNumber: string | null
  lotNumber: string | null
  partItemNumber: string | null
  partName: string | null
  quantity: number | null
  workOrder: { id: string; itemNumber: string } | null
  children: Array<GenealogyNode>
}

export interface PhysicalPartGenealogy {
  composition: Array<GenealogyNode>
  whereUsed: Array<GenealogyNode>
}

/** Composition and where-used, derived from work order consumption. */
export function physicalPartGenealogyQuery(id: string) {
  return queryOptions({
    queryKey: qk.sub('physical-parts', id, 'genealogy'),
    queryFn: async (): Promise<PhysicalPartGenealogy> => {
      const result = await apiFetch<{ data: PhysicalPartGenealogy }>(
        `/api/v1/physical-parts/${id}/genealogy`,
      )
      return result.data
    },
  })
}

export interface AsBuiltLine {
  partMasterId: string
  partItemNumber: string | null
  partName: string | null
  designedQuantity: number | null
  consumedQuantity: number | null
  status: 'match' | 'missing' | 'extra' | 'quantity_mismatch'
}

export interface AsBuiltComparison {
  asBuiltItem: {
    id: string
    itemNumber: string
    revision: string
  } | null
  producedUnitCount: number
  lines: Array<AsBuiltLine>
}

/** The BOM of the built revision against what the producing order consumed. */
export function physicalPartAsBuiltQuery(id: string) {
  return queryOptions({
    queryKey: qk.sub('physical-parts', id, 'as-built-comparison'),
    queryFn: async (): Promise<AsBuiltComparison> => {
      const result = await apiFetch<{ data: AsBuiltComparison }>(
        `/api/v1/physical-parts/${id}/as-built-comparison`,
      )
      return result.data
    },
  })
}
