// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

export const filePayloadSchema = z.object({
  fileId: z.string().uuid(),
  itemId: z.string().uuid(),
  /**
   * The master of the item version the file belongs to. A file row hangs off
   * one item *version*, so `itemId` alone cannot follow a part's files across
   * its revisions; the master id is the identity that survives a release.
   */
  itemMasterId: z.string().uuid(),
  branchId: z.string().uuid().nullable(),
  fileName: z.string(),
  fileCategory: z.string().nullable(),
  fileVersion: z.number().int(),
  fileSize: z.number().int(),
  mimeType: z.string(),
  fileHash: z.string().nullable(),
  /** For a check-in: the version record this one supersedes. */
  previousFileId: z.string().uuid().nullable(),
})

export type FilePayload = z.infer<typeof filePayloadSchema>

/**
 * A new file was attached to an item — version 1 of a file lineage.
 *
 * ## The boundary
 *
 * `file.*` records what somebody did to a file. Two writers move file rows
 * without anybody doing anything to a file, and are silent by design:
 *
 * - **Version carry.** Every new item version — a working copy on a change
 *   order's branch, the revision a release puts on main — starts with copies
 *   of the previous version's file rows. They are the same files on a new
 *   version row, and announcing them would turn every checkout into a file
 *   storm. `itemMasterId` is what lets a consumer follow a file through them.
 * - **Promotion.** A release makes the files attached on its branch visible
 *   on main. That is part of the release, which `design.released` and
 *   `item.released` already announce.
 */
export const FILE_UPLOADED = defineDomainEvent({
  type: 'file.uploaded',
  schemaVersion: 1,
  description: 'A file was uploaded to an item',
  subjectType: 'item',
  payloadSchema: filePayloadSchema,
})

/**
 * A checked-out file was checked in with new content, creating the next
 * version record. Emitted in the transaction that demotes the previous
 * latest version and inserts the new one.
 */
export const FILE_CHECKED_IN = defineDomainEvent({
  type: 'file.checked_in',
  schemaVersion: 1,
  description: 'A file was checked in as a new version',
  subjectType: 'item',
  payloadSchema: filePayloadSchema,
})

/** A file was soft-deleted (it stays downloadable from the vault). */
export const FILE_DELETED = defineDomainEvent({
  type: 'file.deleted',
  schemaVersion: 1,
  description: 'A file was deleted from an item',
  subjectType: 'item',
  payloadSchema: filePayloadSchema,
})

/**
 * A soft-deleted file was restored to its item: the reverse of
 * `file.deleted`. Without it, a consumer that honoured the deletion would keep
 * the file gone for good.
 */
export const FILE_RESTORED = defineDomainEvent({
  type: 'file.restored',
  schemaVersion: 1,
  description: 'A deleted file was restored to its item',
  subjectType: 'item',
  payloadSchema: filePayloadSchema,
})
