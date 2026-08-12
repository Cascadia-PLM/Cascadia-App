// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Manifest diffing and source-level field-change expansion for Software items.
 *
 * Lives apart from SoftwareSourceService so ItemService / CheckoutService can
 * expand manifest changes into per-file history rows without importing the
 * full source service (which itself imports ItemService).
 */

import { eq } from 'drizzle-orm'
import { db } from '../db'
import { softwareManifests } from '../db/schema'
import type { SoftwareManifestEntry } from '../db/schema/software'
import type { FieldChange } from './CommitService'

export interface ManifestDiffEntry {
  path: string
  status: 'added' | 'removed' | 'modified'
  oldHash?: string
  newHash?: string
  oldSize?: number
  newSize?: number
}

/** Pure path-level diff between two entry lists. */
export function diffManifestEntries(
  fromEntries: Array<SoftwareManifestEntry>,
  toEntries: Array<SoftwareManifestEntry>,
): Array<ManifestDiffEntry> {
  const fromMap = new Map(fromEntries.map((e) => [e.path, e]))
  const toMap = new Map(toEntries.map((e) => [e.path, e]))

  const diff: Array<ManifestDiffEntry> = []
  for (const [path, from] of fromMap) {
    const to = toMap.get(path)
    if (!to) {
      diff.push({
        path,
        status: 'removed',
        oldHash: from.hash,
        oldSize: from.size,
      })
    } else if (to.hash !== from.hash) {
      diff.push({
        path,
        status: 'modified',
        oldHash: from.hash,
        newHash: to.hash,
        oldSize: from.size,
        newSize: to.size,
      })
    }
  }
  for (const [path, to] of toMap) {
    if (!fromMap.has(path)) {
      diff.push({ path, status: 'added', newHash: to.hash, newSize: to.size })
    }
  }

  return diff.sort((a, b) => a.path.localeCompare(b.path))
}

async function getManifestEntries(
  manifestId: string | null,
): Promise<Array<SoftwareManifestEntry>> {
  if (!manifestId) return []
  const [manifest] = await db
    .select()
    .from(softwareManifests)
    .where(eq(softwareManifests.id, manifestId))
    .limit(1)
  return manifest?.entries ?? []
}

/**
 * Expand a Software item's `manifestId` field change into per-file `source`
 * rows (proposal §3.5): one row per added/modified/deleted path, with
 * {hash, size} as old/new values. The opaque manifestId row is replaced -
 * the per-file rows ARE the change. Non-Software items and change sets
 * without a manifestId change pass through untouched.
 */
export async function expandSourceFieldChanges(
  itemType: string,
  fieldChanges: Array<FieldChange>,
): Promise<Array<FieldChange>> {
  if (itemType !== 'Software') return fieldChanges

  const manifestChange = fieldChanges.find(
    (fc) => fc.fieldName === 'manifestId',
  )
  if (!manifestChange) return fieldChanges

  const [fromEntries, toEntries] = await Promise.all([
    getManifestEntries((manifestChange.oldValue as string | null) ?? null),
    getManifestEntries((manifestChange.newValue as string | null) ?? null),
  ])

  const sourceRows: Array<FieldChange> = diffManifestEntries(
    fromEntries,
    toEntries,
  ).map((d) => ({
    fieldCategory: 'source',
    fieldName: d.status === 'removed' ? 'deleted' : d.status,
    fieldPath: d.path,
    oldValue: d.oldHash ? { hash: d.oldHash, size: d.oldSize } : null,
    newValue: d.newHash ? { hash: d.newHash, size: d.newSize } : null,
  }))

  return [
    ...fieldChanges.filter((fc) => fc.fieldName !== 'manifestId'),
    ...sourceRows,
  ]
}
