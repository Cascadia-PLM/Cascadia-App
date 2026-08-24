// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import {
  lifecycleByItemTypeQuery,
  releasedFamilyStateIds,
} from '@/lib/query/options/lifecycles'

/**
 * Whether an item's state is immutable released lineage, per its own
 * lifecycle's change-action mappings — the client-side counterpart of
 * `LifecycleService.isReleasedFamilyState`.
 *
 * A presentation hint only (hide an Import button, dim an editor): the
 * server's `ItemEditPolicy` is what actually refuses the edit. Resolves to
 * `false` while the lifecycle is still loading and for Free lifecycles, which
 * define no release actions.
 */
export function useReleasedFamily(
  itemType: string | undefined,
  state: string | null | undefined,
): { isReleasedFamily: boolean; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    ...lifecycleByItemTypeQuery(itemType ?? ''),
    enabled: Boolean(itemType),
  })
  const family = releasedFamilyStateIds(data)
  return {
    isReleasedFamily: Boolean(state) && family.includes(state as string),
    isLoading,
  }
}
