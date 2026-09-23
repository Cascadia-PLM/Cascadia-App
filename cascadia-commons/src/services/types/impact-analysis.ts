// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Wire types for change-impact analysis — what `ImpactAnalysisService`
 * computes and the impact UI renders. Declared apart from the service so the
 * web package can name them; the service re-exports them.
 */

import type { ThreadDomain } from '../../thread/types'

export type ChangeType =
  'revision' | 'obsolescence' | 'bom_removal' | 'specification_change'

export type ImpactDirection = 'upstream' | 'downstream' | 'both'

export type ImpactSeverity = 'critical' | 'high' | 'medium' | 'low'

export type ImpactType = 'direct' | 'indirect'

export interface ImpactedItem {
  item: {
    id: string
    masterId: string
    itemNumber: string
    name: string | null
    itemType: string
    revision: string
    state: string
    designId: string | null
    designName?: string
  }
  impactPath: Array<string> // Chain of itemNumbers from source to this item
  impactType: ImpactType // direct (1 hop) or indirect (2+ hops)
  domain: ThreadDomain
  severity: ImpactSeverity
  reason: string // Human-readable explanation
  requiredAction?: string // Suggested action
  depth: number
  relationshipType: string
}

export interface ImpactAnalysisRequest {
  itemId: string
  changeType: ChangeType
  direction: ImpactDirection
  maxDepth?: number // Default: 5
  includeDomains?: Array<ThreadDomain> // Default: all domains
}

export interface ImpactAnalysisResult {
  sourceItem: {
    id: string
    itemNumber: string
    name: string | null
    itemType: string
    revision: string
    state: string
    designId: string | null
  }
  changeType: ChangeType
  impactedItems: Array<ImpactedItem>
  summary: {
    totalImpacted: number
    byDomain: Record<ThreadDomain, number>
    bySeverity: Record<ImpactSeverity, number>
    crossDesignCount: number // Items in other designs
  }
  recommendations: Array<string>
  analyzedAt: Date
}
