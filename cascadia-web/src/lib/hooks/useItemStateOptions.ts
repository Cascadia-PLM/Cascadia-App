// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { lifecycleListQuery } from '@/lib/query/options/lifecycles'

/**
 * Filter-dropdown options for lifecycle state: every state id across every
 * lifecycle definition, in first-seen order, labelled by its display name.
 *
 * Read from the definitions rather than from the code-defined state lists on
 * the item types. Those lists are configuration's stale shadow — the change
 * order's named nine states that never matched any shipped workflow, so the
 * global state filter offered states no item could hold and omitted the ones
 * it could. Empty until the definitions load.
 */
export function useItemStateOptions(): Array<{ label: string; value: string }> {
  const { data: definitions = [] } = useQuery(lifecycleListQuery())

  return useMemo(() => {
    const seen = new Set<string>()
    const options: Array<{ label: string; value: string }> = []
    for (const definition of definitions) {
      for (const state of definition.states) {
        if (seen.has(state.id)) continue
        seen.add(state.id)
        options.push({ label: state.name, value: state.id })
      }
    }
    return options
  }, [definitions])
}
