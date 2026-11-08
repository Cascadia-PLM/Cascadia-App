// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { jsonValueSchema } from '../types/base'

/**
 * An edge's `metadata`: free-form JSON a caller attaches to one relationship —
 * a note on an evidence link, a supplier's line reference, whatever the
 * integration needs that the line's own columns do not hold.
 *
 * The column is shared. The server keeps its own bookkeeping in it too — a
 * trace claim's affirmation, see `items/trace-affirmation.ts` in the api — and
 * a key the server writes is never one a caller may. Every write path that
 * takes caller metadata therefore splits the value: the caller owns every key
 * but the reserved ones, and the reserved ones are carried over from what is
 * stored. A value a caller sends under a reserved key is dropped rather than
 * refused, because every read returns the column whole: a client that edits
 * one key and sends the rest back must not be rejected for echoing the
 * server's own stamp.
 *
 * Shared by the api (the write paths) and the web (the edit dialog, which
 * hides what it cannot change), so it imports nothing server-side.
 */

/** The key under which an edge's `metadata` holds its trace affirmation. */
export const AFFIRMATION_KEY = 'affirmed'

/** Keys the server writes into an edge's `metadata` and callers cannot. */
export const RESERVED_RELATIONSHIP_METADATA_KEYS: ReadonlySet<string> = new Set(
  [AFFIRMATION_KEY],
)

/** What a caller may send as an edge's `metadata`: a JSON object. */
export const relationshipMetadataSchema = z
  .record(z.string(), jsonValueSchema)
  .describe(
    'Free-form JSON object. Keys the server maintains (`affirmed`, a trace ' +
      "link's affirmation) are not writable: a value sent under one is " +
      'ignored and the stored one kept.',
  )

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function pick(
  metadata: unknown,
  keep: (key: string) => boolean,
): Record<string, unknown> | null {
  const record = asRecord(metadata)
  if (!record) return null
  const entries = Object.entries(record).filter(([key]) => keep(key))
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/**
 * The caller-owned part of an edge's `metadata`: every key but the reserved
 * ones. Null when nothing is left, so `{}` and `null` read alike.
 */
export function userMetadataOf(
  metadata: unknown,
): Record<string, unknown> | null {
  return pick(metadata, (key) => !RESERVED_RELATIONSHIP_METADATA_KEYS.has(key))
}

/**
 * The `metadata` to store when a caller replaces an edge's own keys: `next`'s
 * caller-owned keys over the reserved keys of what is `stored`. `next: null`
 * clears the caller's keys and keeps the server's.
 */
export function withUserMetadata(
  stored: unknown,
  next: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const reserved = pick(stored, (key) =>
    RESERVED_RELATIONSHIP_METADATA_KEYS.has(key),
  )
  const merged = { ...userMetadataOf(next), ...reserved }
  return Object.keys(merged).length > 0 ? merged : null
}

/** JSON with object keys sorted, so two equal documents serialize alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = asRecord(value)
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Whether two `metadata` values say the same thing to a caller, ignoring the
 * reserved keys and key order — Postgres reorders a `jsonb` object's keys on
 * the way in, so a stored value never compares equal to the body that wrote
 * it by serialization alone.
 */
export function sameUserMetadata(a: unknown, b: unknown): boolean {
  return canonicalJson(userMetadataOf(a)) === canonicalJson(userMetadataOf(b))
}
