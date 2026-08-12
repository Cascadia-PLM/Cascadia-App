// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, isNull, ne, not, or, sql } from 'drizzle-orm'
import { items } from './schema'

/**
 * Reusable filter that excludes soft-deleted items.
 * Uses the defensive pattern: treats NULL and false as "not deleted"
 * for backward compatibility with rows inserted before the column existed.
 */
export function notDeleted() {
  return or(isNull(items.isDeleted), eq(items.isDeleted, false))!
}

/**
 * Excludes unreleased working copies: versions carrying a branch working
 * revision (`-{branchId8}`, or the historical `DRAFT` / `-` markers) rather
 * than a revision the merge assigned.
 *
 * The SQL counterpart of `RevisionService.isWorkingRevision`, for queries
 * that answer "what is released" without going through the commit graph.
 */
export function notWorkingRevision() {
  return and(
    not(sql`${items.revision} LIKE '-%'`),
    ne(items.revision, 'DRAFT'),
    ne(items.revision, ''),
  )!
}
