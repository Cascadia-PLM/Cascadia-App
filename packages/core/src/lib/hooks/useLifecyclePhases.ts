// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import type {
  LifecyclePhaseConfig,
  RevisionScheme,
} from '@/lib/types/lifecycle'
import type { WorkflowState } from '@/lib/workflows/types'
import { apiFetch } from '@/lib/api/client'

interface LifecycleData {
  lifecycleId: string | null
  name: string | null
  phases: Array<LifecyclePhaseConfig>
  states: Array<WorkflowState>
  revisionScheme: RevisionScheme | null
}

export interface PhaseInfo {
  id: string
  name: string
  color?: string
  order: number
}

// Module-level cache: deduplicates requests across multiple hook instances
const lifecycleCache = new Map<string, Promise<LifecycleData | null>>()

function fetchLifecycle(itemType: string): Promise<LifecycleData | null> {
  const existing = lifecycleCache.get(itemType)
  if (existing) return existing

  const promise = apiFetch<{ data: LifecycleData }>(
    `/api/v1/lifecycles/by-item-type/${encodeURIComponent(itemType)}`,
  )
    .then((res) => res.data)
    .catch(() => null)

  lifecycleCache.set(itemType, promise)
  return promise
}

/**
 * Client-side hook for efficient lifecycle phase resolution.
 * Fetches lifecycle definition once per item type using a module-level cache
 * so data grids with many rows only make one API call.
 */
export function useLifecyclePhases(itemType?: string) {
  const [data, setData] = useState<LifecycleData | null>(null)
  const [loading, setLoading] = useState(!!itemType)

  useEffect(() => {
    if (!itemType) {
      setLoading(false)
      return
    }

    let cancelled = false

    fetchLifecycle(itemType).then((result) => {
      if (!cancelled) {
        setData(result)
        setLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [itemType])

  /**
   * Resolve the phase for a given state. Stored item state is a state ID
   * (WI-5.1); the name match is display-layer generosity for historical
   * values.
   * Returns null if no phase is assigned to that state.
   */
  const resolvePhase = (state: string): PhaseInfo | null => {
    if (!data?.phases || data.phases.length === 0) return null

    const match = data.states.find((s) => s.id === state || s.name === state)
    if (!match?.phaseId) return null

    // Find the phase
    const phase = data.phases.find((p) => p.id === match.phaseId)
    if (!phase) return null

    return {
      id: phase.id,
      name: phase.name,
      color: phase.color,
      order: phase.order,
    }
  }

  return { resolvePhase, loading, data }
}
