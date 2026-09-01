// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

/** One file in a software manifest: path, content hash, byte size. */
export interface SoftwareManifestEntry {
  path: string
  hash: string
  size: number
}

/**
 * A software item's source tree.
 *
 * `isDraft` reports which manifest the entries actually came from. Asking for
 * the draft when the item has none falls back to the committed tree, so the
 * flag — not the request — is what tells the UI it is looking at uncommitted
 * work.
 */
export interface SoftwareTree {
  itemId: string
  revision: string
  manifestId: string | null
  draftManifestId: string | null
  isDraft: boolean
  fileCount: number
  totalSize: number
  entries: Array<SoftwareManifestEntry>
}

/** One source file's content. Binary files carry a flag instead of a preview. */
export interface SoftwareFile {
  path: string
  hash: string
  size: number
  isBinary: boolean
  content: string
  encoding: 'utf8' | 'base64'
}

/** One version of a software master, for the revision-compare picker. */
export interface SoftwareVersion {
  id: string
  revision: string
  state: string
  isCurrent: boolean | null
  /** ISO timestamp — the server's `Date` after JSON serialization. */
  modifiedAt: string
  manifestId: string | null
}

/** One path that differs between two manifests. */
export interface SoftwareDiffChange {
  path: string
  status: 'added' | 'removed' | 'modified'
  oldHash?: string
  newHash?: string
}

/**
 * A software item's source tree.
 *
 * `draft` is part of the key, not just the URL: the draft tree and the
 * committed tree are two different answers to the same question rather than
 * one answer that goes stale, so a viewer showing each must not share a cache
 * entry.
 */
export function softwareTreeQuery(
  itemId: string,
  options: { draft?: boolean } = {},
) {
  const draft = options.draft ?? false

  return queryOptions({
    queryKey: qk.sub('software', itemId, 'tree', { draft }),
    queryFn: async (): Promise<SoftwareTree> => {
      const result = await apiFetch<{ data: SoftwareTree }>(
        `/api/v1/software/${itemId}/tree?draft=${draft}`,
      )
      return result.data
    },
    enabled: Boolean(itemId),
  })
}

/**
 * One file out of a software item's tree.
 *
 * The path is a query parameter rather than a route segment, so it is keyed
 * explicitly. Pass `null` while nothing is selected — the viewer keeps the
 * selection in local state and this read follows it, which is what lets a file
 * opened twice be served from the cache instead of refetched.
 */
export function softwareFileQuery(
  itemId: string,
  path: string | null,
  options: { draft?: boolean } = {},
) {
  const draft = options.draft ?? false
  const search =
    path === null ? null : `path=${encodeURIComponent(path)}&draft=${draft}`

  return queryOptions({
    queryKey: qk.sub('software', itemId, 'file', { path, draft }),
    queryFn: async (): Promise<SoftwareFile> => {
      const result = await apiFetch<{ data: { file: SoftwareFile } }>(
        `/api/v1/software/${itemId}/file?${search}`,
      )
      return result.data.file
    },
    enabled: Boolean(itemId) && search !== null,
  })
}

/**
 * Every version of this software master, newest first.
 *
 * Only the compare dialog wants it, so it is gated: `enabled` is false until
 * the dialog opens rather than loading a second list behind every source tab.
 */
export function softwareVersionsQuery(itemId: string, enabled = true) {
  return queryOptions({
    queryKey: qk.sub('software', itemId, 'versions'),
    queryFn: async (): Promise<Array<SoftwareVersion>> => {
      const result = await apiFetch<{
        data: { versions: Array<SoftwareVersion> }
      }>(`/api/v1/software/${itemId}/versions`)
      return result.data.versions
    },
    enabled: enabled && Boolean(itemId),
  })
}

/**
 * The paths that differ between another version of this software master and
 * this one. `fromItemId` is `null` until the user picks a side to compare
 * against.
 */
export function softwareDiffQuery(itemId: string, fromItemId: string | null) {
  return queryOptions({
    queryKey: qk.sub('software', itemId, 'diff', { fromItemId }),
    queryFn: async (): Promise<Array<SoftwareDiffChange>> => {
      const result = await apiFetch<{
        data: { changes: Array<SoftwareDiffChange> }
      }>(`/api/v1/software/${itemId}/diff?fromItemId=${fromItemId}`)
      return result.data.changes
    },
    enabled: Boolean(itemId) && fromItemId !== null,
  })
}
