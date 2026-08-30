// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { entitySubQuery } from './entities'
import type { UpstreamChangeItem } from '@/lib/db/schema/thread'

/**
 * One upstream-change notification raised against an MBOM: an ECO released on
 * the source engineering design, and the items that ECO touched.
 *
 * The server builds this as `UpstreamChangeResult` in `MbomService`, but that
 * module imports the database, so the client cannot borrow the type from it —
 * see "Server-Only Imports in Client Code" in `docs/development/ui-components.md`.
 * `UpstreamChangeItem` is safe to reach for because it is the shape of a JSONB
 * column and a type-only import erases at compile time.
 */
export interface UpstreamChange {
  id: string
  sourceDesignId: string
  sourceDesignName: string
  sourceDesignCode: string
  sourceEcoNumber: string | null
  changedItems: Array<UpstreamChangeItem>
  status: string
  /** ISO timestamp — the server's `Date` after JSON serialization. */
  createdAt: string
}

/**
 * Upstream changes still awaiting review on one MBOM design.
 *
 * `MbomService.getPendingUpstreamChanges` filters `status = 'pending'`, so a
 * row that has been reviewed at all — accepted, rejected or deferred — drops
 * out of this list, and nothing in the codebase writes `pending` back onto an
 * existing row. Reviewing is one-way.
 *
 * Deliberately not primed from the design detail loader: the endpoint rejects
 * a non-Manufacturing design with a `ValidationError`, and its only reader is
 * `UpstreamChangesBanner`, which mounts for Manufacturing designs alone.
 */
export function upstreamChangesQuery(designId: string) {
  return entitySubQuery<UpstreamChange>(
    'mbom',
    designId,
    'upstream-changes',
    'changes',
  )
}
