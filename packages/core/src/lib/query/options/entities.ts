// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { Resource } from '../keys'
import { apiFetch } from '@/lib/api/client'

/**
 * A single entity fetched from `/api/v1/{resource}/{id}`.
 *
 * Every `$id` detail route in the app follows this shape — the response is
 * `{ data: { <singular>: T } }` — so they share one factory instead of each
 * route repeating the fetch, the unwrap, and the error handling.
 *
 * `unwrap` names the singular key inside `data` (`'part'`, `'document'`, …).
 *
 * Pass `enabled: false` to hold the fetch until the caller has an id worth
 * asking about — a detail only some branch of the UI needs.
 *
 * @example
 * const partQuery = (id: string) => entityQuery<Part>('parts', id, 'part')
 */
export function entityQuery<T>(
  resource: Resource,
  id: string,
  unwrap: string,
  enabled = true,
) {
  return queryOptions({
    queryKey: qk.detail(resource, id),
    queryFn: async (): Promise<T> => {
      const result = await apiFetch<{ data: Record<string, unknown> }>(
        `/api/v1/${resource}/${id}`,
      )
      return result.data[unwrap] as T
    },
    enabled,
  })
}

/**
 * A sub-collection hanging off one entity — `/api/v1/{resource}/{id}/{sub}`.
 *
 * Keyed beneath the entity, so invalidating the entity also refreshes it.
 */
export function entitySubQuery<T>(
  resource: Resource,
  id: string,
  sub: string,
  unwrap: string,
  options: { search?: string } = {},
) {
  const suffix = options.search ? `?${options.search}` : ''
  return queryOptions({
    queryKey: qk.sub(resource, id, sub, options.search ?? undefined),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: Record<string, unknown> }>(
        `/api/v1/${resource}/${id}/${sub}${suffix}`,
      )
      return (result.data[unwrap] as Array<T> | undefined) ?? []
    },
  })
}

/**
 * A whole resource collection fetched from `/api/v1/{resource}` with no
 * paging — the shape used by pickers and reference lists (designs, programs,
 * roles) that several routes load at once.
 */
export function collectionQuery<T>(
  resource: Resource,
  unwrap: string,
  options: { search?: string } = {},
) {
  const suffix = options.search ? `?${options.search}` : ''
  return queryOptions({
    queryKey: qk.list(resource, options.search ?? {}),
    queryFn: async (): Promise<Array<T>> => {
      const result = await apiFetch<{ data: Record<string, unknown> }>(
        `/api/v1/${resource}${suffix}`,
      )
      return (result.data[unwrap] as Array<T> | undefined) ?? []
    },
  })
}
