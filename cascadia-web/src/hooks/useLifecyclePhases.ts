// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import type { LifecyclePhaseConfig } from '@cascadia/commons/types/lifecycle'
import { lifecycleByItemTypeQuery } from '@/query'

export type PhaseInfo = Pick<
  LifecyclePhaseConfig,
  'id' | 'name' | 'color' | 'order'
>

/**
 * Resolve phases through the same query used by route loaders and lifecycle
 * editing. Invalidation refreshes every badge instead of leaving a second
 * module cache with the old definition for the rest of the session.
 */
export function useLifecyclePhases(itemType?: string) {
  const query = useQuery({
    ...lifecycleByItemTypeQuery(itemType ?? ''),
    enabled: Boolean(itemType),
  })
  const data = query.data ?? null
  const loading = Boolean(itemType) && query.isPending

  /**
   * Resolve the phase for a given state. Stored item state is a state ID
   * (WI-5.1); the name match is display-layer generosity for historical
   * values.
   * Returns null if no phase is assigned to that state.
   */
  const resolvePhase = (state: string): PhaseInfo | null => {
    if (!data?.phases.length) return null

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
