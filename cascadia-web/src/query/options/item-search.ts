// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

export interface ItemSearchParams {
  /** Item type to search within, e.g. `Part`. Required by the endpoint. */
  itemType: string
  limit?: number
  state?: string
  /**
   * Which designs to search, mirroring the endpoint's own `designScope`:
   * `'current'` confines results to `contextDesignId`, `'library'` to the
   * Standard Library. Omit to search every design.
   *
   * Structure a design owns — a BOM line, say — can only point at items that
   * design (or the shared library) also owns, so the pickers that build it
   * scope the search rather than filter a global list.
   */
  designScope?: 'current' | 'library'
  /**
   * Mirrors the endpoint's `contextDesignId`: the design `'current'` filters
   * on, and the one results are marked `isExternal` against. Worth sending
   * under `'library'` too, so library hits come back flagged as outside the
   * design the caller is working in.
   */
  contextDesignId?: string
  /**
   * Comma-separated design ids the endpoint confines results to. Distinct
   * from `designScope`/`contextDesignId`: this is an explicit set, which is
   * what the requirement and relationship pickers want.
   */
  designIds?: string
}

/**
 * Items of one type, for the pickers that let a user choose a target.
 *
 * Keyed as an `items` collection so creating or deleting an item refreshes
 * every open picker rather than leaving each with the snapshot its effect
 * happened to load.
 */
export function itemSearchQuery<T>(params: ItemSearchParams, enabled = true) {
  const {
    itemType,
    limit = 50,
    state,
    designScope,
    contextDesignId,
    designIds,
  } = params

  return queryOptions({
    queryKey: qk.collection('items', 'search', {
      itemType,
      limit,
      state,
      designScope,
      contextDesignId,
      designIds,
    }),
    queryFn: async (): Promise<Array<T>> => {
      const search = new URLSearchParams({ itemType, limit: String(limit) })
      if (state) search.set('state', state)
      if (designScope) search.set('designScope', designScope)
      if (contextDesignId) search.set('contextDesignId', contextDesignId)
      if (designIds) search.set('designIds', designIds)
      const result = await apiFetch<{ data: { items?: Array<T> } }>(
        `/api/v1/items/search?${search}`,
      )
      return result.data.items ?? []
    },
    // `designScope: 'current'` without a design would search everything, which
    // is the opposite of what the caller asked for
    enabled:
      enabled &&
      Boolean(itemType) &&
      (designScope !== 'current' || Boolean(contextDesignId)),
  })
}

export interface ItemTextSearchParams {
  /** Free text; the caller decides the minimum length worth searching. */
  q: string
  /** Item types to search, e.g. `['Part']`. */
  types: Array<string>
  limit?: number
  /** How far outside the current design to look. */
  designScope?: string
  /** The design the search is run from, for scope resolution. */
  contextDesignId?: string
  /** Comma-separated design ids to confine results to. */
  designIds?: string
}

/**
 * Free-text item search, scoped to a design context.
 *
 * Distinct from `itemSearchQuery` because it answers a different question —
 * "what matches this text" rather than "what items of this type exist" — and
 * the endpoint takes a different parameter set. Callers pass a debounced term
 * (see `useDebouncedValue`) so the key settles between keystrokes and repeated
 * terms resolve from cache.
 */
export function itemTextSearchQuery<T>(
  params: ItemTextSearchParams,
  enabled = true,
) {
  const {
    q,
    types,
    limit = 50,
    designScope,
    contextDesignId,
    designIds,
  } = params

  return queryOptions({
    queryKey: qk.collection('items', 'text-search', {
      q,
      types,
      limit,
      designScope,
      contextDesignId,
      designIds,
    }),
    queryFn: async (): Promise<Array<T>> => {
      const search = new URLSearchParams({
        q,
        types: types.join(','),
        limit: String(limit),
      })
      if (designScope) search.set('designScope', designScope)
      if (contextDesignId) search.set('contextDesignId', contextDesignId)
      if (designIds) search.set('designIds', designIds)
      const result = await apiFetch<{ data: { items?: Array<T> } }>(
        `/api/v1/items/search?${search}`,
      )
      return result.data.items ?? []
    },
    enabled,
  })
}
