// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import type { ItemFilters } from '@/lib/query'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui'
import { itemCountsQuery, lifecycleByItemTypeQuery } from '@/lib/query'

interface LifecycleStateCardsProps {
  itemType: string
  /** The list's current filters; counts are scoped to the same rows */
  filters: ItemFilters
  total: number
  totalLabel: string
  /**
   * Supply counts directly instead of querying (for lists that already hold
   * every row, e.g. the task board). Keys are state IDs.
   */
  counts?: Record<string, number>
}

/**
 * Summary cards for a list page: the total, then one card per state of the
 * item type's lifecycle — in the lifecycle's own order, under its own names,
 * however many there are. Nothing here knows what a state is called.
 *
 * Counts come from `/items?countStates=`, where the *client* names the states
 * it wants — which is fine, because it names them from the lifecycle it just
 * loaded, not from code.
 */
export function LifecycleStateCards({
  itemType,
  filters,
  total,
  totalLabel,
  counts: providedCounts,
}: LifecycleStateCardsProps) {
  const { data: lifecycle } = useQuery(lifecycleByItemTypeQuery(itemType))
  const states = lifecycle?.states ?? []
  const stateIds = states.map((s) => s.id)

  const { data: queriedCounts } = useQuery({
    ...itemCountsQuery(filters, stateIds),
    enabled: providedCounts === undefined && stateIds.length > 0,
  })
  const counts = providedCounts ?? queriedCounts

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]">
      <Card>
        <CardHeader className="pb-3">
          <CardDescription>{totalLabel}</CardDescription>
          <CardTitle className="text-3xl">{total}</CardTitle>
        </CardHeader>
      </Card>
      {states.map((state) => (
        <Card key={state.id}>
          <CardHeader className="pb-3">
            <CardDescription>{state.name}</CardDescription>
            <CardTitle className="text-3xl">
              {counts?.[state.id] ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}
