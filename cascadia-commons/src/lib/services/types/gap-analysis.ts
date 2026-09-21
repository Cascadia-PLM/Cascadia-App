// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Wire types for traceability gap analysis — what `GapAnalysisService`
 * computes and the gap-analysis UI renders. Declared apart from the service
 * so the web package can name them; the service re-exports them.
 */

import type { ThreadDomain } from '../../thread/types'

export type GapType =
  | 'unallocated_requirement'
  | 'unsatisfied_requirement'
  | 'unverified_requirement'
  | 'untested_part'
  | 'unmapped_ebom_item'
  | 'orphan_mbom_item'
  | 'missing_documentation'

export type GapSeverity = 'critical' | 'major' | 'minor'

export interface Gap {
  id: string
  type: GapType
  itemId: string
  itemNumber: string
  itemName: string | null
  itemType: string
  revision: string
  state: string
  domain: ThreadDomain
  severity: GapSeverity
  priority?: string | null
  suggestion: string
  relatedDesignId?: string
  relatedDesignName?: string
}

export interface GapAnalysisRequest {
  designId: string
  includeTypes?: Array<GapType>
  includeDomains?: Array<ThreadDomain>
  includeSeverities?: Array<GapSeverity>
}

export interface GapAnalysisResult {
  designId: string
  designName: string
  analyzedAt: Date
  gaps: Array<Gap>
  summary: {
    totalGaps: number
    byType: Record<GapType, number>
    bySeverity: Record<GapSeverity, number>
    byDomain: Record<ThreadDomain, number>
    completeness: number
  }
  coverage: {
    requirements: {
      total: number
      allocated: number
      satisfied: number
      verified: number
    }
    engineering: {
      total: number
      tested: number
      mappedToMbom: number
    }
    manufacturing: {
      total: number
      linkedToEbom: number
    }
  }
}
