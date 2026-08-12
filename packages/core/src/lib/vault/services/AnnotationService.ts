// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, asc, count, eq, inArray } from 'drizzle-orm'
import type {
  AnnotationGeometry,
  AnnotationKind,
  CreateAnnotationInput,
  FileAnnotation,
  UpdateAnnotationInput,
} from '../annotations'
import { db } from '@/lib/db'
import { vaultFileAnnotations, vaultFiles } from '@/lib/db/schema/vault'
import { items } from '@/lib/db/schema/items'
import { users } from '@/lib/db/schema/users'
import { branchItems, branches } from '@/lib/db/schema/versioning'
import { takeFirst } from '@/lib/db/take-first'
import {
  BranchProtectionError,
  ItemCheckoutRequiredError,
  NotFoundError,
  PermissionDeniedError,
  ResourceLockedError,
  ValidationError,
} from '@/lib/errors'

/**
 * Markup on vault files.
 *
 * Reading markup needs nothing beyond access to the file. **Writing it
 * requires holding the owning item's checkout.** Marking up a released drawing
 * is an edit to the engineering record, not a personal sticky note, so it
 * belongs to whoever currently owns that record — which also means redlines
 * accumulate against a branch someone is accountable for, rather than
 * appearing on main with nobody's name on the change.
 */
export class AnnotationService {
  /** Every annotation on a file, oldest first, with author names resolved. */
  static async list(fileId: string): Promise<Array<FileAnnotation>> {
    const rows = await db
      .select({
        annotation: vaultFileAnnotations,
        authorName: users.name,
      })
      .from(vaultFileAnnotations)
      .leftJoin(users, eq(users.id, vaultFileAnnotations.authorId))
      .where(eq(vaultFileAnnotations.fileId, fileId))
      .orderBy(asc(vaultFileAnnotations.createdAt))

    return rows.map((row) => toAnnotation(row.annotation, row.authorName))
  }

  /**
   * Add markup to a file.
   *
   * Throws `ItemCheckoutRequiredError` when nobody holds the checkout,
   * `ResourceLockedError` when somebody else does, and `BranchProtectionError`
   * when the branch is locked for approval. Those three are different problems
   * with different fixes, so they are not collapsed into one error here.
   */
  static async create(
    fileId: string,
    input: CreateAnnotationInput,
    userId: string,
  ): Promise<FileAnnotation> {
    const item = await this.requireEditableFileOwner(fileId, userId)

    const inserted = takeFirst(
      await db
        .insert(vaultFileAnnotations)
        .values({
          fileId,
          itemId: item.id,
          pageNumber: input.pageNumber,
          kind: input.geometry.kind,
          geometry: input.geometry,
          color: input.color,
          contents: input.contents?.trim() ?? null,
          authorId: userId,
        })
        .returning(),
    )

    return toAnnotation(inserted, null)
  }

  /**
   * Revise markup.
   *
   * Only the author may edit their own markup: an annotation is an attributed
   * statement about the document, and letting a second person rewrite it under
   * the first person's name would make the attribution a lie. Anyone holding
   * the checkout can still delete markup that no longer applies.
   */
  static async update(
    annotationId: string,
    input: UpdateAnnotationInput,
    userId: string,
  ): Promise<FileAnnotation> {
    const existing = await this.getOrThrow(annotationId)
    await this.requireEditableFileOwner(existing.fileId, userId)

    if (existing.authorId !== userId) {
      throw new PermissionDeniedError('markup by another author', 'edit', {
        operation: 'AnnotationService.update',
        annotationId,
      })
    }

    if (input.geometry && input.geometry.kind !== existing.kind) {
      throw new ValidationError(
        'Markup cannot change kind; delete it and draw the new shape instead',
      )
    }

    const updated = takeFirst(
      await db
        .update(vaultFileAnnotations)
        .set({
          ...(input.color === undefined ? {} : { color: input.color }),
          ...(input.contents === undefined
            ? {}
            : { contents: input.contents?.trim() ?? null }),
          ...(input.geometry === undefined ? {} : { geometry: input.geometry }),
          updatedAt: new Date(),
        })
        .where(eq(vaultFileAnnotations.id, annotationId))
        .returning(),
    )

    return toAnnotation(updated, null)
  }

  /** Remove markup. The author, or anyone else holding the checkout, may. */
  static async delete(annotationId: string, userId: string): Promise<void> {
    const existing = await this.getOrThrow(annotationId)
    await this.requireEditableFileOwner(existing.fileId, userId)

    await db
      .delete(vaultFileAnnotations)
      .where(eq(vaultFileAnnotations.id, annotationId))
  }

  /** How many annotations sit on each of these files. Drives the list badge. */
  static async countByFile(
    fileIds: Array<string>,
  ): Promise<Record<string, number>> {
    if (fileIds.length === 0) return {}

    const rows = await db
      .select({
        fileId: vaultFileAnnotations.fileId,
        total: count(),
      })
      .from(vaultFileAnnotations)
      .where(inArray(vaultFileAnnotations.fileId, fileIds))
      .groupBy(vaultFileAnnotations.fileId)

    const counts: Record<string, number> = {}
    for (const row of rows) counts[row.fileId] = row.total
    return counts
  }

  // ============================================
  // Internals
  // ============================================

  private static async getOrThrow(annotationId: string) {
    const row = (
      await db
        .select()
        .from(vaultFileAnnotations)
        .where(eq(vaultFileAnnotations.id, annotationId))
        .limit(1)
    )[0]

    if (!row) throw new NotFoundError('Annotation', annotationId)
    return row
  }

  /**
   * Resolve the file's owning item and assert the caller holds its checkout.
   *
   * Gated on the checkout itself rather than on
   * `ItemService.requireContentEditable`, which is the contract for *structural*
   * edits and additionally insists a revision working copy exist before a
   * released item can be touched. Markup writes no item row and no
   * relationship — it hangs off the file — so that extra step would only mean
   * a reviewer had to revise a document before they could redline it.
   *
   * Matching on `itemMasterId` rather than the item id is deliberate: once a
   * working copy is created the branch row's `currentItemId` moves to the new
   * version, and markup on the released revision's own attachment must keep
   * working across that boundary.
   *
   * Deleted files are refused outright — markup on a file nobody can open is
   * not worth the ambiguity it leaves in the record.
   */
  private static async requireEditableFileOwner(
    fileId: string,
    userId: string,
  ) {
    const file = (
      await db
        .select({
          id: vaultFiles.id,
          itemId: vaultFiles.itemId,
          deletedAt: vaultFiles.deletedAt,
        })
        .from(vaultFiles)
        .where(eq(vaultFiles.id, fileId))
        .limit(1)
    )[0]

    if (!file) throw new NotFoundError('File', fileId)
    if (file.deletedAt) {
      throw new ValidationError('File has been deleted')
    }

    const item = (
      await db.select().from(items).where(eq(items.id, file.itemId)).limit(1)
    )[0]

    if (!item) throw new NotFoundError('Item', file.itemId)

    const identifier = item.itemNumber || item.id

    // Every branch that tracks this item, main included. A design with an
    // unprotected main lets people hold the edit lock there, and markup has to
    // work wherever the lock legitimately lives — the row still has to name
    // this user, so a merged-in main row nobody checked out grants nothing.
    const tracking = await db
      .select({
        branchName: branches.name,
        isLocked: branches.isLocked,
        checkedOutBy: branchItems.checkedOutBy,
      })
      .from(branchItems)
      .innerJoin(branches, eq(branchItems.branchId, branches.id))
      .where(
        and(
          eq(branchItems.itemMasterId, item.masterId),
          eq(branches.isArchived, false),
        ),
      )

    const mine = tracking.find((row) => row.checkedOutBy === userId)

    if (mine) {
      // A submitted ECO locks its branch: the package under review must not
      // change out from under the approvers, markup included.
      if (mine.isLocked) {
        throw new BranchProtectionError(
          `Cannot mark up: branch "${mine.branchName}" is locked (ECO submitted for approval)`,
          { operation: 'AnnotationService.write', itemId: item.id },
        )
      }
      return item
    }

    if (tracking.some((row) => row.checkedOutBy !== null)) {
      throw new ResourceLockedError(identifier, 'checked out by another user', {
        operation: 'AnnotationService.write',
        itemId: item.id,
      })
    }

    throw new ItemCheckoutRequiredError(identifier, {
      operation: 'AnnotationService.write',
      itemId: item.id,
    })
  }
}

type AnnotationRow = typeof vaultFileAnnotations.$inferSelect

function toAnnotation(
  row: AnnotationRow,
  authorName: string | null,
): FileAnnotation {
  return {
    id: row.id,
    fileId: row.fileId,
    itemId: row.itemId,
    pageNumber: row.pageNumber,
    kind: row.kind as AnnotationKind,
    geometry: row.geometry as AnnotationGeometry,
    color: row.color,
    contents: row.contents,
    authorId: row.authorId,
    authorName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
