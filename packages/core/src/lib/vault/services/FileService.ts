// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'
import { db } from '../../db'
import { items, users, vaultFileHistory, vaultFiles } from '../../db/schema'
import { StorageFactory } from '../storage'
import {
  detectFileCategory,
  extractFileMetadata,
  generateFileHash,
  generateStoragePath,
  getAllowedExtensions,
  getFileExtension,
  getThumbnailImageExtensions,
  isFileTypeAllowed,
  isThumbnailableImage,
  sanitizeFilename,
  validateFileSize,
} from '../utils'
import { CommitService } from '../../services/CommitService'
import { BranchService } from '../../services/BranchService'
import { ItemService } from '../../items/services/ItemService'
import { THUMBNAIL_FILE_CATEGORY } from '../file-categories'
import type { CategorySource, FileCategory } from '../file-categories'
import type { SQL } from 'drizzle-orm'
import type { TransactionClient } from '../../db'
import type { FileUploadMetadata, VaultStorage } from '../storage'
import type { AccessScope } from '@/lib/db/filters'
import { vaultLogger } from '@/lib/logging/logger'
import { accessScopeCondition, notDeleted } from '@/lib/db/filters'
import { takeFirst } from '@/lib/db/take-first'
import {
  AlreadyExistsError,
  ConflictError,
  FileTooLargeError,
  FileTypeNotAllowedError,
  InternalError,
  NotFoundError,
  PermissionDeniedError,
  ResourceLockedError,
  ValidationError,
} from '@/lib/errors'

/**
 * How a file's bytes were read, as recorded in `vault_file_history`.
 *
 * `view` is the in-app viewer rendering a file; `download` is a copy leaving
 * the system. Auditors care about the distinction, so the two never collapse
 * into one another.
 */
export type FileAccessAction = 'download' | 'view'

export interface CadMetadata {
  software?: string // e.g., 'SolidWorks 2024', 'Fusion360'
  units?: string // e.g., 'mm', 'in', 'ft'
  polygonCount?: number // For mesh files (STL, OBJ)
  boundingBox?: { x: number; y: number; z: number } // Model dimensions
  hasColors?: boolean // Per-face colors preserved (GLB written by the CAD converter)
}

export interface FileRecord {
  id: string
  itemId: string
  branchId: string | null
  fileName: string
  originalFileName: string
  fileSize: number
  mimeType: string
  fileHash: string
  storageType: string
  storagePath: string
  fileVersion: number
  fileCategory: string | null
  categorySource: string
  isPrimaryModel: boolean
  isItemThumbnail: boolean
  isLatestVersion: boolean
  isCheckedOut: boolean
  checkedOutBy: string | null
  checkedOutAt: Date | null
  uploadedBy: string
  uploadedAt: Date
  metadata: any
  cadMetadata: CadMetadata | null
  thumbnailFileId: string | null
  deletedAt: Date | null
  deletedBy: string | null
}

export interface FileRecordWithItem extends FileRecord {
  item: {
    id: string
    itemNumber: string
    itemType: string
    name: string | null
    state: string
  }
  uploader: {
    id: string
    name: string | null
    email: string
  }
}

export interface UploadFileOptions {
  itemId: string
  branchId?: string
  file: Buffer
  metadata: FileUploadMetadata
  uploadedBy: string
  maxSizeBytes?: number
  allowDuplicates?: boolean
  /** Designate this upload as the item's thumbnail (image files only) */
  isItemThumbnail?: boolean
}

export interface CheckoutInfo {
  fileId: string
  userId: string
}

/**
 * Service layer for vault file operations
 * Handles file upload, download, versioning, check-out/check-in
 */
const MAX_FILE_CHECKOUT_HOURS = parseInt(
  process.env.MAX_FILE_CHECKOUT_HOURS || '24',
  10,
)

export class FileService {
  /**
   * Get storage instance from database settings (with fallback to env)
   */
  private static async getStorage(): Promise<VaultStorage> {
    return StorageFactory.createFromSettings()
  }

  /**
   * Upload a file to the vault
   */
  static async uploadFile(options: UploadFileOptions): Promise<FileRecord> {
    const {
      itemId,
      branchId,
      file,
      metadata,
      uploadedBy,
      maxSizeBytes = 100 * 1024 * 1024, // 100MB default
      allowDuplicates = true, // Opt-in: set false to reject files with duplicate SHA-256 hashes per item
      isItemThumbnail = false,
    } = options

    // Validate file size
    if (!validateFileSize(file.length, maxSizeBytes)) {
      throw new FileTooLargeError(maxSizeBytes, file.length)
    }

    // Validate file type
    if (!isFileTypeAllowed(metadata.originalFileName, metadata.mimeType)) {
      const ext = getFileExtension(metadata.originalFileName)
      throw new FileTypeNotAllowedError(
        ext || metadata.mimeType,
        getAllowedExtensions(),
      )
    }

    // Reject a non-image thumbnail request before storing any bytes
    if (
      isItemThumbnail &&
      !isThumbnailableImage(metadata.originalFileName, metadata.mimeType)
    ) {
      throw new ValidationError(
        `Only image files can be used as an item thumbnail (${getThumbnailImageExtensions().join(', ')})`,
      )
    }

    // Get item to validate it exists and get masterId
    const result = await db
      .select()
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1)

    const item = result.at(0)

    if (!item) {
      throw new NotFoundError('Item', itemId)
    }

    // Generate file hash
    const fileHash = await generateFileHash(file)

    // Check for duplicates if not allowed
    if (!allowDuplicates) {
      const existing = await db
        .select()
        .from(vaultFiles)
        .where(
          and(
            eq(vaultFiles.itemId, itemId),
            eq(vaultFiles.fileHash, fileHash),
            isNull(vaultFiles.deletedAt),
          ),
        )
        .limit(1)

      if (existing.length > 0) {
        throw new AlreadyExistsError('File', metadata.originalFileName)
      }
    }

    // Generate unique file ID
    const fileId = crypto.randomUUID()

    // Sanitize filename
    const sanitized = sanitizeFilename(metadata.originalFileName)

    // Generate storage path
    const storagePath = generateStoragePath(
      item.masterId,
      item.revision,
      fileId,
      1, // Initial version
      sanitized,
    )

    // Store file in vault
    const storage = await this.getStorage()
    await storage.store(storagePath, file)

    // Verify file was stored correctly
    const storedSize = await storage.getSize(storagePath)
    if (storedSize !== file.length) {
      // Rollback - delete the file
      await storage.delete(storagePath)
      throw new InternalError(
        'File storage verification failed: stored size does not match upload size',
      )
    }

    // Extract additional metadata
    const extractedMetadata = await extractFileMetadata(
      metadata.originalFileName,
      metadata.mimeType,
      file,
    )

    const combinedMetadata = {
      ...extractedMetadata,
      description: metadata.description,
      ...metadata,
    }

    // Detect file category
    const fileCategory = detectFileCategory(
      metadata.originalFileName,
      metadata.mimeType,
    )

    // Check if this is the first CAD model for this item (auto-mark as primary)
    let isPrimaryModel = false
    if (fileCategory === 'cad_model') {
      const existingCadFiles = await db
        .select()
        .from(vaultFiles)
        .where(
          and(
            eq(vaultFiles.itemId, itemId),
            eq(vaultFiles.fileCategory, 'cad_model'),
            isNull(vaultFiles.deletedAt),
          ),
        )
        .limit(1)

      // If no existing CAD files, mark this as primary
      isPrimaryModel = existingCadFiles.length === 0
    }

    // A newly designated thumbnail replaces any previous one for this item
    if (isItemThumbnail) {
      await this.clearItemThumbnailFlag(itemId)
    }

    // Insert file record
    const fileRecord = takeFirst(
      await db
        .insert(vaultFiles)
        .values({
          id: fileId,
          itemId,
          branchId: branchId ?? null,
          fileName: sanitized,
          originalFileName: metadata.originalFileName,
          fileSize: file.length,
          mimeType: metadata.mimeType,
          fileHash,
          storageType: (process.env.VAULT_TYPE as string) || 'local',
          storagePath,
          fileVersion: 1,
          isLatestVersion: true,
          isCheckedOut: false,
          uploadedBy,
          metadata: combinedMetadata,
          fileCategory,
          isPrimaryModel,
          isItemThumbnail,
        })
        .returning(),
    )

    // Log upload action
    await this.logAction({
      fileId,
      action: 'upload',
      performedBy: uploadedBy,
      details: {
        originalFileName: metadata.originalFileName,
        fileSize: file.length,
        mimeType: metadata.mimeType,
        isItemThumbnail,
      },
    })

    if (isItemThumbnail) {
      await this.logAction({
        fileId,
        action: 'set_thumbnail',
        performedBy: uploadedBy,
        details: { itemId, fileName: metadata.originalFileName },
      })
    }

    // Track file attachment in commit history
    if (item.designId) {
      try {
        // Determine which branch to commit to
        const branchInfo = await ItemService.getItemBranchInfo(itemId)
        let targetBranchId: string | null = branchId ?? null

        if (!targetBranchId) {
          if (branchInfo) {
            targetBranchId = branchInfo.branchId
          } else {
            const mainBranch = await BranchService.getMainBranch(item.designId)
            targetBranchId = mainBranch?.id || null
          }
        }

        if (targetBranchId) {
          await CommitService.create(
            {
              branchId: targetBranchId,
              message: `File attached to ${item.itemNumber || 'item'}: ${metadata.originalFileName}`,
              itemChanges: [
                {
                  itemId,
                  changeType: 'modified',
                  fieldChanges: [
                    {
                      fieldName: 'file_attached',
                      fieldPath: 'files',
                      oldValue: null,
                      newValue: {
                        fileId,
                        fileName: metadata.originalFileName,
                        fileSize: file.length,
                        mimeType: metadata.mimeType,
                      },
                      fieldCategory: 'attribute',
                    },
                  ],
                },
              ],
            },
            uploadedBy,
          )
        }
      } catch (error) {
        vaultLogger.warn(
          { err: error },
          'Failed to create commit for file upload',
        )
      }
    }

    return fileRecord as FileRecord
  }

  /**
   * Upload multiple files at once
   */
  static async uploadFiles(
    itemId: string,
    files: Array<{ data: Buffer; metadata: FileUploadMetadata }>,
    uploadedBy: string,
  ): Promise<Array<FileRecord>> {
    const results: Array<FileRecord> = []

    for (const file of files) {
      const result = await this.uploadFile({
        itemId,
        file: file.data,
        metadata: file.metadata,
        uploadedBy,
      })
      results.push(result)
    }

    return results
  }

  /**
   * Download a file from the vault
   *
   * `access` records why the bytes were read. Reading a controlled document in
   * the in-app viewer is a different event from taking a copy of it, and the
   * audit trail has to be able to tell them apart.
   */
  static async downloadFile(
    fileId: string,
    userId: string,
    access: FileAccessAction = 'download',
  ): Promise<Buffer> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (file.deletedAt) {
      throw new ValidationError('File has been deleted')
    }

    // Get file from storage
    const storage = await this.getStorage()
    const data = await storage.retrieve(file.storagePath)

    // Log the access
    await this.logAction({
      fileId,
      action: access,
      performedBy: userId,
      details: {
        fileSize: data.length,
      },
    })

    return data
  }

  /**
   * Create a read stream for a file (for large file downloads)
   */
  static async createFileStream(
    fileId: string,
    userId: string,
    access: FileAccessAction = 'download',
  ): Promise<ReadableStream> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (file.deletedAt) {
      throw new ValidationError('File has been deleted')
    }

    // Get stream from storage
    const storage = await this.getStorage()
    const stream = await storage.createReadStream(file.storagePath)

    // Log the access
    await this.logAction({
      fileId,
      action: access,
      performedBy: userId,
      details: {
        fileSize: file.fileSize,
        streaming: true,
      },
    })

    return stream
  }

  /**
   * Get file metadata without downloading
   */
  static async getFileMetadata(fileId: string): Promise<FileRecord | null> {
    const [file] = await db
      .select()
      .from(vaultFiles)
      .where(eq(vaultFiles.id, fileId))
      .limit(1)

    return file as FileRecord | null
  }

  /**
   * List all files for an item
   */
  static async listItemFiles(
    itemId: string,
    includeDeleted: boolean = false,
  ): Promise<Array<FileRecord>> {
    const conditions = [
      eq(vaultFiles.itemId, itemId),
      // Exclude thumbnail files from normal listings
      or(
        isNull(vaultFiles.fileCategory),
        ne(vaultFiles.fileCategory, 'thumbnail'),
      ),
    ]

    if (!includeDeleted) {
      conditions.push(isNull(vaultFiles.deletedAt))
    }

    const files = await db
      .select()
      .from(vaultFiles)
      .where(and(...conditions))
      .orderBy(desc(vaultFiles.uploadedAt))

    return files as Array<FileRecord>
  }

  /**
   * List files for an item filtered by version context (branch)
   * - Files with branchId = null are visible everywhere (legacy files)
   * - Files with branchId = mainBranchId are visible on main and all branches
   * - Files with branchId = branchId are visible on that specific branch
   */
  static async listItemFilesAtContext(
    itemId: string,
    context: { branchId?: string; mainBranchId?: string },
    includeDeleted: boolean = false,
  ): Promise<Array<FileRecord>> {
    // If no context provided, fall back to listing all files
    if (!context.branchId && !context.mainBranchId) {
      return this.listItemFiles(itemId, includeDeleted)
    }

    // Build branch visibility conditions
    // Files are visible if:
    // 1. branchId is null (legacy/global files)
    // 2. branchId matches mainBranchId (files uploaded on main)
    // 3. branchId matches the current branchId (files uploaded on this branch)
    const branchConditions = [isNull(vaultFiles.branchId)]

    if (context.mainBranchId) {
      branchConditions.push(eq(vaultFiles.branchId, context.mainBranchId))
    }

    if (context.branchId && context.branchId !== context.mainBranchId) {
      branchConditions.push(eq(vaultFiles.branchId, context.branchId))
    }

    const baseConditions = [
      eq(vaultFiles.itemId, itemId),
      // Exclude thumbnail files from normal listings
      or(
        isNull(vaultFiles.fileCategory),
        ne(vaultFiles.fileCategory, 'thumbnail'),
      ),
    ]

    if (!includeDeleted) {
      baseConditions.push(isNull(vaultFiles.deletedAt))
    }

    const files = await db
      .select()
      .from(vaultFiles)
      .where(and(...baseConditions, or(...branchConditions)))
      .orderBy(desc(vaultFiles.uploadedAt))

    return files as Array<FileRecord>
  }

  /**
   * Promote files from a branch to main (set branchId to null)
   * Called when an ECO is released/merged to make branch files visible everywhere
   */
  static async promoteFilesToMain(
    branchId: string,
    tx?: TransactionClient,
  ): Promise<number> {
    const result = await (tx ?? db)
      .update(vaultFiles)
      .set({ branchId: null })
      .where(eq(vaultFiles.branchId, branchId))
      .returning({ id: vaultFiles.id })

    return result.length
  }

  /**
   * Carry an item version's files onto another version of that item.
   *
   * A file row belongs to one item *version*, so every place that mints a new
   * version - a working copy on an ECO branch, the released revision at merge -
   * starts with no files unless they are brought across. Left alone, a part's
   * CAD and attachments vanish the moment the new row becomes the one listings
   * resolve to.
   *
   * The rows are copied, not moved: the version being superseded keeps owning
   * its own attachments, which is what lets the SUPERSEDED watermark stamp the
   * old revision's PDFs without touching the new one. Copies reference the same
   * `storagePath` rather than duplicating bytes - safe because a rewrite
   * (`replaceContent`) always writes a fresh path and never mutates a blob in
   * place, so the two versions can never scribble on each other.
   *
   * Only the latest non-deleted version of each file comes across. Superseded
   * file versions stay with the row they happened on; the new item version
   * starts from the file as it stands, not its editing history.
   */
  static async copyFilesToItem(args: {
    sourceItemId: string
    targetItemId: string
    /** Where the copies are visible; null means everywhere (i.e. released). */
    branchId?: string | null
    tx?: TransactionClient
  }): Promise<number> {
    const { sourceItemId, targetItemId, branchId = null, tx } = args

    // Promotion in place - the files already hang off the target.
    if (sourceItemId === targetItemId) return 0

    const client = tx ?? db

    const sourceFiles = await client
      .select()
      .from(vaultFiles)
      .where(
        and(
          eq(vaultFiles.itemId, sourceItemId),
          eq(vaultFiles.isLatestVersion, true),
          isNull(vaultFiles.deletedAt),
        ),
      )

    if (sourceFiles.length === 0) return 0

    // Ids are minted up front so a CAD file's generated thumbnail can be
    // re-pointed at the copied thumbnail rather than the old version's.
    const newIds = new Map<string, string>()
    for (const file of sourceFiles) {
      newIds.set(file.id, crypto.randomUUID())
    }

    await client.insert(vaultFiles).values(
      sourceFiles.map((file) => ({
        id: newIds.get(file.id)!,
        itemId: targetItemId,
        branchId,
        fileName: file.fileName,
        originalFileName: file.originalFileName,
        fileSize: file.fileSize,
        mimeType: file.mimeType,
        fileHash: file.fileHash,
        storageType: file.storageType,
        storagePath: file.storagePath,
        fileVersion: file.fileVersion,
        isLatestVersion: true,
        // A held edit lock belongs to the version it was taken on.
        isCheckedOut: false,
        // Provenance is the upload, not this copy: the file was not re-uploaded
        // by whoever released the change, and listings order on uploadedAt.
        uploadedBy: file.uploadedBy,
        uploadedAt: file.uploadedAt,
        metadata: file.metadata,
        fileCategory: file.fileCategory,
        categorySource: file.categorySource,
        isPrimaryModel: file.isPrimaryModel,
        isItemThumbnail: file.isItemThumbnail,
        cadMetadata: file.cadMetadata,
        thumbnailFileId: file.thumbnailFileId
          ? (newIds.get(file.thumbnailFileId) ?? null)
          : null,
      })),
    )

    return sourceFiles.length
  }

  /**
   * Delete a file (soft delete)
   */
  static async deleteFile(fileId: string, userId: string): Promise<void> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (file.deletedAt) {
      throw new ValidationError('File is already deleted')
    }

    // Check if file is checked out
    if (file.isCheckedOut) {
      throw new ResourceLockedError('File', 'Cannot delete a checked-out file')
    }

    // Get item for tracking
    const item = await db
      .select()
      .from(items)
      .where(eq(items.id, file.itemId))
      .limit(1)
      .then((r) => r.at(0))

    // Soft delete
    await db
      .update(vaultFiles)
      .set({
        deletedAt: new Date(),
        deletedBy: userId,
      })
      .where(eq(vaultFiles.id, fileId))

    // Log delete action
    await this.logAction({
      fileId,
      action: 'delete',
      performedBy: userId,
      details: {
        originalFileName: file.originalFileName,
      },
    })

    // Track file removal in commit history
    if (item?.designId) {
      try {
        // Determine which branch to commit to
        const branchInfo = await ItemService.getItemBranchInfo(file.itemId)
        let targetBranchId: string | null = file.branchId

        if (!targetBranchId) {
          if (branchInfo) {
            targetBranchId = branchInfo.branchId
          } else {
            const mainBranch = await BranchService.getMainBranch(item.designId)
            targetBranchId = mainBranch?.id || null
          }
        }

        if (targetBranchId) {
          await CommitService.create(
            {
              branchId: targetBranchId,
              message: `File removed from ${item.itemNumber || 'item'}: ${file.originalFileName}`,
              itemChanges: [
                {
                  itemId: file.itemId,
                  changeType: 'modified',
                  fieldChanges: [
                    {
                      fieldName: 'file_removed',
                      fieldPath: 'files',
                      oldValue: {
                        fileId,
                        fileName: file.originalFileName,
                        fileSize: file.fileSize,
                        mimeType: file.mimeType,
                      },
                      newValue: null,
                      fieldCategory: 'attribute',
                    },
                  ],
                },
              ],
            },
            userId,
          )
        }
      } catch (error) {
        vaultLogger.warn(
          { err: error },
          'Failed to create commit for file deletion',
        )
      }
    }
  }

  /**
   * Permanently delete a file from storage (admin only)
   */
  static async permanentlyDeleteFile(
    fileId: string,
    _userId: string,
  ): Promise<void> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    // Delete from storage
    const storage = await this.getStorage()
    await storage.delete(file.storagePath)

    // Delete from database
    await db.delete(vaultFiles).where(eq(vaultFiles.id, fileId))

    // Note: History is preserved via cascade
  }

  /**
   * Restore a deleted file
   */
  static async restoreFile(fileId: string, userId: string): Promise<void> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (!file.deletedAt) {
      throw new ValidationError('File is not deleted')
    }

    // Restore file
    await db
      .update(vaultFiles)
      .set({
        deletedAt: null,
        deletedBy: null,
      })
      .where(eq(vaultFiles.id, fileId))

    // Log restore action
    await this.logAction({
      fileId,
      action: 'restore',
      performedBy: userId,
      details: {
        originalFileName: file.originalFileName,
      },
    })
  }

  /**
   * Name the holder of a file's edit lock, and refuse.
   *
   * Every way of losing the lock ends here, so what a loser is told does not
   * depend on which way they lost. The holder is named as a person rather
   * than as the raw user id the message used to carry: `getFileLockStatus`
   * already discloses that person's name and email to anyone who can see the
   * file, so this reveals nothing new and reads like an answer.
   */
  private static async refuseLockedByAnother(
    fileId: string,
    holderId: string | null,
  ): Promise<never> {
    const holder = holderId
      ? await db
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, holderId))
          .limit(1)
      : []

    throw new ResourceLockedError(
      'File',
      `already checked out by ${holder.at(0)?.name || holder.at(0)?.email || 'another user'}`,
      { operation: 'FileService.checkOutFile', fileId },
    )
  }

  /**
   * Take the edit lock on a file row that is free and not deleted.
   *
   * `is_checked_out = false` and `deleted_at IS NULL` ride in the UPDATE's own
   * WHERE, so the row's state at write time decides the winner. An empty
   * `returning()` is an ordinary outcome — somebody else got there — which is
   * why this answers `false` rather than throwing or using `takeFirst`.
   */
  private static async claimFileLock(
    fileId: string,
    userId: string,
  ): Promise<boolean> {
    const claimed = await db
      .update(vaultFiles)
      .set({
        isCheckedOut: true,
        checkedOutBy: userId,
        checkedOutAt: new Date(),
      })
      .where(
        and(
          eq(vaultFiles.id, fileId),
          eq(vaultFiles.isCheckedOut, false),
          isNull(vaultFiles.deletedAt),
        ),
      )
      .returning({ id: vaultFiles.id })

    return claimed.at(0) !== undefined
  }

  /**
   * Unwind one file's checkout, but only while it is still expired.
   *
   * `forceReleaseLock` is the admin unlock: it clears whatever is there, which
   * is right for a person pressing the button and wrong on this path. Between
   * reading a stale lock and releasing it, another caller can claim the row
   * fresh, and an unconditional clear would take that brand-new lock away —
   * reintroducing, one layer down, the very overwrite this method exists to
   * prevent. The age predicate is `cleanupExpiredCheckouts`' own, narrowed to
   * a single row: a lock claimed since the read carries a `checked_out_at` of
   * now, so it cannot match, and the release becomes a no-op instead of theft.
   *
   * The history entry matches what `forceReleaseLock(…, 'auto-expired')`
   * wrote, so the audit trail for an auto-expiry is unchanged.
   */
  private static async releaseExpiredLock(
    fileId: string,
    releasedBy: string,
  ): Promise<boolean> {
    const cutoff = new Date(
      Date.now() - MAX_FILE_CHECKOUT_HOURS * 60 * 60 * 1000,
    )

    const released = await db
      .update(vaultFiles)
      .set({
        isCheckedOut: false,
        checkedOutBy: null,
        checkedOutAt: null,
      })
      .where(
        and(
          eq(vaultFiles.id, fileId),
          eq(vaultFiles.isCheckedOut, true),
          lt(vaultFiles.checkedOutAt, cutoff),
        ),
      )
      .returning({ id: vaultFiles.id })

    if (!released.at(0)) return false

    await this.logAction({
      fileId,
      action: 'auto-expired',
      performedBy: releasedBy,
      details: { reason: 'auto-expired' },
    })

    return true
  }

  /**
   * Check out a file (lock for editing)
   *
   * The claim is a compare-and-set, not a decision taken from a SELECT moments
   * earlier. It used to be the latter: read the row, conclude in JavaScript
   * that nobody held it, then `UPDATE … WHERE id = $1` unconditionally. Two
   * callers reaching that read together both concluded the file was free and
   * both wrote, and the second silently overwrote the first — two people
   * holding the same exclusive lock on a binary CAD file, which is precisely
   * the lost work check-out exists to prevent. Nothing surfaced it: the loser
   * got a 200 and a lock they did not have.
   *
   * Same shape as `CheckoutService.claimExistingCheckout` for item checkouts,
   * down to the two passes. The second pass exists for two states only — an
   * expired lock this call has just unwound, and a lock released between the
   * first claim and the read that followed it. Spinning against live
   * contention would turn a 423 into a hang.
   */
  static async checkOutFile(fileId: string, userId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = await this.getFileMetadata(fileId)

      if (!file) {
        throw new NotFoundError('File', fileId)
      }

      if (file.deletedAt) {
        throw new ValidationError('Cannot check out a deleted file')
      }

      if (file.isCheckedOut) {
        // Only an expired lock may be taken off its holder.
        if (!FileService.isLockExpired(file.checkedOutAt)) {
          await FileService.refuseLockedByAnother(fileId, file.checkedOutBy)
        }
        if (!(await FileService.releaseExpiredLock(fileId, userId))) {
          // Somebody else unwound it first, or re-took it fresh. Either way
          // the read above is stale — go round and decide against the truth.
          continue
        }
      }

      if (await FileService.claimFileLock(fileId, userId)) {
        // Logged only on a real claim: a checkout entry for a caller who
        // never held the lock is a lie in the file's history.
        await this.logAction({
          fileId,
          action: 'checkout',
          performedBy: userId,
          details: {
            originalFileName: file.originalFileName,
          },
        })
        return
      }
    }

    // Two passes and the lock is still not ours. Name whoever holds it now,
    // or say the row was contended throughout. What must never happen is
    // returning as though the checkout had succeeded.
    const settled = await this.getFileMetadata(fileId)
    if (settled?.isCheckedOut) {
      await FileService.refuseLockedByAnother(fileId, settled.checkedOutBy)
    }
    throw new ResourceLockedError(
      'File',
      'contended by concurrent checkouts; try again',
      { operation: 'FileService.checkOutFile', fileId },
    )
  }

  /**
   * Retire the current head of a file's version chain, inside the caller's
   * transaction, and say whether this caller is the one who retired it.
   *
   * The same compare-and-set `checkOutFile` uses for the edit lock, applied to
   * the version chain: `is_latest_version = true` rides the UPDATE's own WHERE
   * and the write is read back with `.returning()`, so the row's state at write
   * time decides who supersedes it. An empty result is an ordinary outcome —
   * somebody else's new version already took the head — which is why this
   * answers `false` rather than throwing. Callers pass whichever of their own
   * read-time preconditions must still hold at write time as `guards`; a
   * precondition checked only by an earlier SELECT is not a precondition.
   *
   * The lock columns are cleared alongside the flags because a superseded row
   * is nobody's to edit. `checkInFile` used to leave `is_checked_out = true`
   * and its holder on the row it demoted — only the no-new-data branch cleared
   * them — so every version created by a check-in left behind a frozen row
   * still advertising a checkout that could never be checked in. That leaked
   * into `getFileLockStatus`, into the admin unlock list, and into
   * `cleanupExpiredCheckouts`, which dutifully "expired" locks on history.
   */
  private static async demoteLatestVersion(
    tx: TransactionClient,
    fileId: string,
    ...guards: Array<SQL>
  ): Promise<boolean> {
    const demoted = await tx
      .update(vaultFiles)
      .set({
        isLatestVersion: false,
        // The thumbnail designation moves to the new version, so it must not
        // linger here and give the item two candidates.
        isItemThumbnail: false,
        isCheckedOut: false,
        checkedOutBy: null,
        checkedOutAt: null,
      })
      .where(
        and(
          eq(vaultFiles.id, fileId),
          eq(vaultFiles.isLatestVersion, true),
          ...guards,
        ),
      )
      .returning({ id: vaultFiles.id })

    return demoted.at(0) !== undefined
  }

  /**
   * Drop a blob written for a version row that was never inserted.
   *
   * Both version-creating paths store the bytes *before* opening their
   * transaction, because the reverse order is worse: a demote that commits and
   * a store that then fails leaves the file with no latest version at all,
   * which is unrecoverable without hand-editing the table. Storing first makes
   * the failure mode an unreferenced blob instead, and nothing reaches a blob
   * except through the row that names it — so an orphan is invisible, not
   * corrupting. This is best effort for that reason: it tidies up when it can,
   * and a failure here is logged rather than raised over the conflict the
   * caller is already reporting.
   */
  private static async discardOrphanedBlob(storagePath: string): Promise<void> {
    try {
      const storage = await this.getStorage()
      await storage.delete(storagePath)
    } catch (error) {
      vaultLogger.warn(
        { err: error, storagePath },
        'Failed to discard the blob of a superseded version write',
      )
    }
  }

  /**
   * Check in a file (unlock and optionally upload new version)
   */
  static async checkInFile(
    fileId: string,
    userId: string,
    newFileData?: Buffer,
    metadata?: FileUploadMetadata,
  ): Promise<FileRecord | null> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (!file.isCheckedOut) {
      throw new ValidationError('File is not checked out')
    }

    if (file.checkedOutBy !== userId) {
      throw new PermissionDeniedError('file', 'check in')
    }

    let newVersion: FileRecord | null = null

    // If new file data provided, create new version
    if (newFileData && metadata) {
      // Get item info
      const result = await db
        .select()
        .from(items)
        .where(eq(items.id, file.itemId))
        .limit(1)

      const item = result.at(0)

      if (!item) {
        throw new NotFoundError('Item', file.itemId)
      }

      // Create new version
      const newVersionNumber = file.fileVersion + 1
      const newFileId = crypto.randomUUID()
      const fileHash = await generateFileHash(newFileData)
      const sanitized = sanitizeFilename(metadata.originalFileName)
      const storagePath = generateStoragePath(
        item.masterId,
        item.revision,
        newFileId,
        newVersionNumber,
        sanitized,
      )

      // Store new version first: the bytes are the side effect that cannot be
      // rolled back, so they go outside the transaction, and the path is keyed
      // on a fresh id that nothing else can collide with.
      const storage = await this.getStorage()
      await storage.store(storagePath, newFileData)

      const extractedMetadata = await extractFileMetadata(
        metadata.originalFileName,
        metadata.mimeType,
        newFileData,
      )

      // Demote and insert as one unit. Two check-ins of the same file — a
      // double-submitted upload is enough — each demoted the old row and each
      // inserted a row claiming to be version N+1 and latest. Two heads of one
      // chain is a state no reader models: `listItemFiles` shows the file
      // twice, `listFileVersions` reports a duplicated version number, and
      // which bytes an item's "current" drawing means depends on row order.
      const newRecord = await db.transaction(async (tx) => {
        // The ownership precondition read above rides into the WHERE with the
        // chain-head predicate: the lock must still be ours at write time, not
        // merely have been ours when we looked.
        const won = await FileService.demoteLatestVersion(
          tx,
          fileId,
          eq(vaultFiles.checkedOutBy, userId),
        )
        if (!won) return null

        // Insert new version record (preserve branchId from original file)
        return takeFirst(
          await tx
            .insert(vaultFiles)
            .values({
              id: newFileId,
              itemId: file.itemId,
              branchId: file.branchId,
              fileName: sanitized,
              originalFileName: metadata.originalFileName,
              fileSize: newFileData.length,
              mimeType: metadata.mimeType,
              fileHash,
              storageType: (process.env.VAULT_TYPE as string) || 'local',
              storagePath,
              fileVersion: newVersionNumber,
              isLatestVersion: true,
              isCheckedOut: false,
              uploadedBy: userId,
              metadata: { ...extractedMetadata, ...metadata },
              // The category rides the version chain. A manual category is a
              // person's answer about the file's role, which a new revision of
              // the same file does not change; an auto category is re-detected,
              // since the replacement may be a different kind of file entirely.
              fileCategory:
                file.categorySource === 'manual'
                  ? file.fileCategory
                  : detectFileCategory(
                      metadata.originalFileName,
                      metadata.mimeType,
                    ),
              categorySource: file.categorySource,
              // Carry the thumbnail designation onto the new version, but only if
              // the replacement is still a usable image
              isItemThumbnail:
                file.isItemThumbnail &&
                isThumbnailableImage(
                  metadata.originalFileName,
                  metadata.mimeType,
                ),
            })
            .returning(),
        )
      })

      if (!newRecord) {
        await FileService.discardOrphanedBlob(storagePath)
        throw new ConflictError(
          `File '${file.originalFileName}' was superseded or unlocked while this check-in was being written; check the file's current version before checking in again`,
          { operation: 'FileService.checkInFile', fileId },
        )
      }

      newVersion = newRecord as FileRecord
    } else {
      // Just unlock without new version
      await db
        .update(vaultFiles)
        .set({
          isCheckedOut: false,
          checkedOutBy: null,
          checkedOutAt: null,
        })
        .where(eq(vaultFiles.id, fileId))
    }

    // Log checkin action
    await this.logAction({
      fileId,
      action: 'checkin',
      performedBy: userId,
      details: {
        originalFileName: file.originalFileName,
        newVersion: newVersion ? newVersion.fileVersion : null,
      },
    })

    return newVersion
  }

  /**
   * Replace a file's content with system-generated bytes, as a new version.
   *
   * This is the path for machine-authored rewrites — stamping a watermark,
   * embedding a signature — which have no human holding a checkout to check
   * back in. It is deliberately *not* an escape hatch around the lock:
   *
   * - A file someone has checked out is refused. They are mid-edit, and their
   *   check-in would silently discard whatever we wrote underneath them.
   * - Only the latest version is replaceable. Superseded versions are frozen
   *   history and rewriting one would make the chain lie.
   * - The previous version keeps its bytes and stays downloadable, so the
   *   pre-stamp original is always recoverable.
   *
   * `action` is what lands in the file's history — 'watermark', 'sign', and so
   * on — so the trail says what the machine did, not a generic 'checkin'.
   *
   * All three refusals are re-checked in the demote's WHERE, so losing to a
   * concurrent writer raises `ConflictError` (409) rather than producing a
   * second chain head. `ConflictError` is the right class for the two callers
   * of this method. `JobService.markFailed` does not consult an error
   * allowlist — it re-queues *any* thrown error until `maxAttempts`, so the
   * watermark job's retry does not depend on the class chosen here; the only
   * allowlist in the tree, `isRetryableError`, governs the browser's fetch
   * client, and 409 is deliberately absent from it because a superseded write
   * must be re-read before it is re-attempted, never blindly replayed. PDF
   * signing is a synchronous route, where 409 is what tells the caller their
   * view of the file is stale — as distinct from the 423 this raises when a
   * person holds the edit lock.
   */
  static async replaceContent(args: {
    fileId: string
    data: Buffer
    /** Recorded as the uploader of the new version. */
    userId: string
    /** History action for the rewrite, e.g. 'watermark'. */
    action: string
    details?: Record<string, unknown>
  }): Promise<FileRecord> {
    const { fileId, data, userId, action } = args

    const file = await this.getFileMetadata(fileId)
    if (!file) throw new NotFoundError('File', fileId)

    if (file.deletedAt) {
      throw new ValidationError('File has been deleted')
    }
    if (!file.isLatestVersion) {
      throw new ValidationError(
        'Only the latest version of a file can be rewritten',
      )
    }
    if (file.isCheckedOut) {
      throw new ResourceLockedError(
        file.originalFileName,
        'checked out for editing',
        { operation: 'FileService.replaceContent', fileId },
      )
    }

    const item = (
      await db.select().from(items).where(eq(items.id, file.itemId)).limit(1)
    ).at(0)

    if (!item) throw new NotFoundError('Item', file.itemId)

    const newVersionNumber = file.fileVersion + 1
    const newFileId = crypto.randomUUID()
    const fileHash = await generateFileHash(data)
    const storagePath = generateStoragePath(
      item.masterId,
      item.revision,
      newFileId,
      newVersionNumber,
      file.fileName,
    )

    // Bytes first, and deliberately so. This used to demote the current version
    // and only then store the new one, which meant a storage failure — a full
    // disk, an S3 timeout — committed the demote and then threw, leaving the
    // file with no latest version at all: invisible to `listItemFiles`,
    // undownloadable, and recoverable only by hand-editing the table. Storing
    // first turns that same failure into an unreferenced blob and no database
    // change whatsoever.
    const storage = await this.getStorage()
    await storage.store(storagePath, data)

    const newRecord = await db.transaction(async (tx) => {
      // Every precondition read above rides into the WHERE, because a machine
      // rewrite runs unattended and its read can be arbitrarily stale: the row
      // must still be the chain head, still undeleted, and still unlocked at
      // the moment the demote lands.
      const won = await FileService.demoteLatestVersion(
        tx,
        fileId,
        isNull(vaultFiles.deletedAt),
        eq(vaultFiles.isCheckedOut, false),
      )
      if (!won) return null

      return takeFirst(
        await tx
          .insert(vaultFiles)
          .values({
            id: newFileId,
            itemId: file.itemId,
            branchId: file.branchId,
            fileName: file.fileName,
            originalFileName: file.originalFileName,
            fileSize: data.length,
            mimeType: file.mimeType,
            fileHash,
            storageType: (process.env.VAULT_TYPE as string) || 'local',
            storagePath,
            fileVersion: newVersionNumber,
            isLatestVersion: true,
            isCheckedOut: false,
            uploadedBy: userId,
            // The rewrite replaces bytes, not meaning: the file is the same
            // document playing the same role, so its category and description
            // ride across verbatim rather than being re-detected.
            metadata: {
              ...(file.metadata as Record<string, unknown> | null),
              [action]: { at: new Date().toISOString(), ...args.details },
            },
            fileCategory: file.fileCategory,
            categorySource: file.categorySource,
            isItemThumbnail: file.isItemThumbnail,
            thumbnailFileId: file.thumbnailFileId,
          })
          .returning(),
      )
    })

    if (!newRecord) {
      await FileService.discardOrphanedBlob(storagePath)
      throw new ConflictError(
        `File '${file.originalFileName}' was superseded, deleted, or checked out while its ${action} was being written; re-read the current version and retry`,
        { operation: 'FileService.replaceContent', fileId },
      )
    }

    await this.logAction({
      fileId: newFileId,
      action,
      performedBy: userId,
      details: {
        originalFileName: file.originalFileName,
        previousFileId: fileId,
        previousVersion: file.fileVersion,
        newVersion: newVersionNumber,
        ...args.details,
      },
    })

    return newRecord as FileRecord
  }

  /**
   * Get file history
   */
  static async getFileHistory(fileId: string): Promise<Array<any>> {
    const history = await db
      .select()
      .from(vaultFileHistory)
      .where(eq(vaultFileHistory.fileId, fileId))
      .orderBy(desc(vaultFileHistory.performedAt))

    return history
  }

  /**
   * Log an action in the file history
   */
  private static async logAction(params: {
    fileId: string
    action: string
    performedBy: string
    details?: any
  }): Promise<void> {
    await db.insert(vaultFileHistory).values({
      fileId: params.fileId,
      action: params.action,
      performedBy: params.performedBy,
      details: params.details || {},
    })
  }

  /**
   * Get storage statistics
   */
  static async getStorageStats(): Promise<{
    totalFiles: number
    totalSize: number
    filesByType: Record<string, number>
  }> {
    const files = await db
      .select()
      .from(vaultFiles)
      .where(isNull(vaultFiles.deletedAt))

    const totalFiles = files.length
    const totalSize = files.reduce(
      (sum, file) => sum + Number(file.fileSize),
      0,
    )

    const filesByType: Record<string, number> = {}
    files.forEach((file) => {
      const type = file.mimeType.split('/')[0]!
      filesByType[type] = (filesByType[type] || 0) + 1
    })

    return { totalFiles, totalSize, filesByType }
  }

  /**
   * Get the primary CAD model file for an item
   * Returns the file marked as isPrimaryModel, or null if none
   */
  static async getPrimaryModel(itemId: string): Promise<FileRecord | null> {
    const [file] = await db
      .select()
      .from(vaultFiles)
      .where(
        and(
          eq(vaultFiles.itemId, itemId),
          eq(vaultFiles.isPrimaryModel, true),
          eq(vaultFiles.isLatestVersion, true),
          isNull(vaultFiles.deletedAt),
        ),
      )
      .limit(1)

    return file as FileRecord | null
  }

  /**
   * Get the image file a user has designated as this item's thumbnail, if any.
   */
  static async getDesignatedThumbnail(
    itemId: string,
  ): Promise<FileRecord | null> {
    const [file] = await db
      .select()
      .from(vaultFiles)
      .where(
        and(
          eq(vaultFiles.itemId, itemId),
          eq(vaultFiles.isItemThumbnail, true),
          eq(vaultFiles.isLatestVersion, true),
          isNull(vaultFiles.deletedAt),
        ),
      )
      .limit(1)

    return (file as FileRecord | undefined) ?? null
  }

  /**
   * Get the thumbnail file ID for an item.
   * Precedence: an image the user explicitly designated, then the generated
   * thumbnail of the primary model, then any file's generated thumbnail.
   */
  static async getItemThumbnailFileId(itemId: string): Promise<string | null> {
    // A user-designated image wins over anything auto-generated
    const designated = await this.getDesignatedThumbnail(itemId)
    if (designated) {
      return designated.id
    }

    // Then the primary model's generated thumbnail
    const primary = await this.getPrimaryModel(itemId)
    if (primary?.thumbnailFileId) {
      return primary.thumbnailFileId
    }

    // Fall back to any file for this item that has a thumbnail
    const [file] = await db
      .select({ thumbnailFileId: vaultFiles.thumbnailFileId })
      .from(vaultFiles)
      .where(
        and(
          eq(vaultFiles.itemId, itemId),
          isNull(vaultFiles.deletedAt),
          isNotNull(vaultFiles.thumbnailFileId),
        ),
      )
      .limit(1)

    return file?.thumbnailFileId ?? null
  }

  /**
   * Clear the thumbnail designation from every file on an item.
   * Returns the number of files that were cleared.
   */
  private static async clearItemThumbnailFlag(itemId: string): Promise<number> {
    const cleared = await db
      .update(vaultFiles)
      .set({ isItemThumbnail: false })
      .where(
        and(
          eq(vaultFiles.itemId, itemId),
          eq(vaultFiles.isItemThumbnail, true),
        ),
      )
      .returning({ id: vaultFiles.id })

    return cleared.length
  }

  /**
   * Designate an uploaded image as its item's thumbnail.
   * Only one file per item can be the thumbnail - this unsets any existing one.
   */
  static async setItemThumbnail(fileId: string, userId: string): Promise<void> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (file.deletedAt) {
      throw new ValidationError('Cannot use a deleted file as a thumbnail')
    }

    if (!isThumbnailableImage(file.originalFileName, file.mimeType)) {
      throw new ValidationError(
        `Only image files can be used as an item thumbnail (${getThumbnailImageExtensions().join(', ')})`,
      )
    }

    await this.clearItemThumbnailFlag(file.itemId)

    await db
      .update(vaultFiles)
      .set({ isItemThumbnail: true })
      .where(eq(vaultFiles.id, fileId))

    await this.logAction({
      fileId,
      action: 'set_thumbnail',
      performedBy: userId,
      details: {
        itemId: file.itemId,
        fileName: file.originalFileName,
      },
    })
  }

  /**
   * Remove the thumbnail designation from an item, falling back to the
   * generated CAD thumbnail (if any).
   */
  static async clearItemThumbnail(
    itemId: string,
    userId: string,
  ): Promise<void> {
    const current = await this.getDesignatedThumbnail(itemId)

    await this.clearItemThumbnailFlag(itemId)

    if (current) {
      await this.logAction({
        fileId: current.id,
        action: 'clear_thumbnail',
        performedBy: userId,
        details: {
          itemId,
          fileName: current.originalFileName,
        },
      })
    }
  }

  /**
   * Overrule a file's auto-detected category, or drop back to auto-detection.
   *
   * Detection is a guess from the filename — a PDF can hold a spec, a
   * certificate, a test report, or a drawing, and nothing in the bytes says
   * which. Passing a category records a person's answer and marks it manual,
   * after which nothing re-detects over it (including a new version uploaded
   * on check-in). Passing `null` clears the override and re-detects.
   *
   * Recategorizing the primary CAD model as something else clears the primary
   * designation but does not promote another file — the item is left with no
   * primary model until someone picks one.
   */
  static async setFileCategory(
    fileId: string,
    category: FileCategory | null,
    userId: string,
  ): Promise<FileRecord> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (file.deletedAt) {
      throw new ValidationError('Cannot recategorize a deleted file')
    }

    if (file.fileCategory === THUMBNAIL_FILE_CATEGORY) {
      throw new ValidationError(
        'Generated thumbnails are managed by the system and cannot be recategorized',
      )
    }

    const nextCategory =
      category ?? detectFileCategory(file.originalFileName, file.mimeType)
    const nextSource: CategorySource = category === null ? 'auto' : 'manual'

    // 'Primary model' only means something for a CAD model — it marks the file
    // the 3D viewer and downstream conversions reach for. Keep the two in step
    // rather than stranding a "primary" specification on the item.
    let isPrimaryModel = file.isPrimaryModel
    if (nextCategory !== 'cad_model') {
      isPrimaryModel = false
    } else if (!isPrimaryModel) {
      // Truthiness, not `=== null`: getPrimaryModel destructures an empty
      // result and hands back undefined despite its `| null` signature.
      isPrimaryModel = !(await this.getPrimaryModel(file.itemId))
    }

    const updated = (
      await db
        .update(vaultFiles)
        .set({
          fileCategory: nextCategory,
          categorySource: nextSource,
          isPrimaryModel,
        })
        .where(eq(vaultFiles.id, fileId))
        .returning()
    ).at(0)

    if (!updated) {
      throw new NotFoundError('File', fileId)
    }

    await this.logAction({
      fileId,
      action: 'set_category',
      performedBy: userId,
      details: {
        itemId: file.itemId,
        fileName: file.originalFileName,
        from: file.fileCategory,
        to: nextCategory,
        source: nextSource,
      },
    })

    return updated as FileRecord
  }

  /**
   * Set a file as the primary CAD model for its item
   * Only one file per item can be primary - this unsets any existing primary
   */
  static async setPrimaryModel(fileId: string, userId: string): Promise<void> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (file.deletedAt) {
      throw new ValidationError('Cannot set a deleted file as primary model')
    }

    // Clear existing primary for this item
    await db
      .update(vaultFiles)
      .set({ isPrimaryModel: false })
      .where(
        and(
          eq(vaultFiles.itemId, file.itemId),
          eq(vaultFiles.isPrimaryModel, true),
        ),
      )

    // Set new primary
    await db
      .update(vaultFiles)
      .set({ isPrimaryModel: true })
      .where(eq(vaultFiles.id, fileId))

    // Log action
    await this.logAction({
      fileId,
      action: 'set_primary',
      performedBy: userId,
      details: {
        itemId: file.itemId,
        fileName: file.originalFileName,
      },
    })
  }

  /**
   * Get the lock (checkout) status of a file with user details
   */
  static async getFileLockStatus(fileId: string): Promise<{
    isLocked: boolean
    isExpired?: boolean
    lockedBy?: { id: string; name: string; email: string }
    lockedAt?: Date
    lockedFor?: number // minutes
  }> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (!file.isCheckedOut || !file.checkedOutBy) {
      return { isLocked: false }
    }

    // Get user info for the locker
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, file.checkedOutBy))
      .limit(1)

    // Calculate lock duration in minutes
    const lockedFor = file.checkedOutAt
      ? Math.floor(
          (Date.now() - new Date(file.checkedOutAt).getTime()) / 1000 / 60,
        )
      : undefined

    return {
      isLocked: true,
      isExpired: FileService.isLockExpired(file.checkedOutAt),
      lockedBy: {
        id: file.checkedOutBy,
        name: user?.name ?? 'Unknown User',
        email: user?.email ?? 'unknown',
      },
      lockedAt: file.checkedOutAt ?? undefined,
      lockedFor,
    }
  }

  /**
   * Check if a file checkout lock has expired based on MAX_FILE_CHECKOUT_HOURS.
   */
  private static isLockExpired(checkedOutAt: Date | null): boolean {
    if (!checkedOutAt) return false
    const maxMs = MAX_FILE_CHECKOUT_HOURS * 60 * 60 * 1000
    return Date.now() - new Date(checkedOutAt).getTime() > maxMs
  }

  /**
   * Force-release a file checkout lock (for admin unlock or auto-expiry).
   */
  static async forceReleaseLock(
    fileId: string,
    releasedBy: string,
    reason: string = 'force-unlock',
  ): Promise<void> {
    await db
      .update(vaultFiles)
      .set({
        isCheckedOut: false,
        checkedOutBy: null,
        checkedOutAt: null,
      })
      .where(eq(vaultFiles.id, fileId))

    await this.logAction({
      fileId,
      action: reason,
      performedBy: releasedBy,
      details: { reason },
    })
  }

  /**
   * Release all expired file checkout locks. Returns number of locks released.
   */
  static async cleanupExpiredCheckouts(): Promise<number> {
    const maxMs = MAX_FILE_CHECKOUT_HOURS * 60 * 60 * 1000
    const cutoff = new Date(Date.now() - maxMs)

    const expired = await db
      .update(vaultFiles)
      .set({
        isCheckedOut: false,
        checkedOutBy: null,
        checkedOutAt: null,
      })
      .where(
        and(
          eq(vaultFiles.isCheckedOut, true),
          lt(vaultFiles.checkedOutAt, cutoff),
        ),
      )
      .returning()

    return expired.length
  }

  /**
   * List all versions of a file
   * Finds the file, then queries all versions with the same fileName and itemId
   */
  static async listFileVersions(fileId: string): Promise<
    Array<{
      id: string
      fileVersion: number
      isLatestVersion: boolean
      fileName: string
      originalFileName: string
      fileSize: number
      mimeType: string
      uploadedAt: Date
      uploadedBy: { id: string; name: string }
    }>
  > {
    // Get the file to find its fileName and itemId
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    // Query all versions with the same fileName and itemId
    const versions = await db
      .select({
        id: vaultFiles.id,
        fileVersion: vaultFiles.fileVersion,
        isLatestVersion: vaultFiles.isLatestVersion,
        fileName: vaultFiles.fileName,
        originalFileName: vaultFiles.originalFileName,
        fileSize: vaultFiles.fileSize,
        mimeType: vaultFiles.mimeType,
        uploadedAt: vaultFiles.uploadedAt,
        uploadedById: vaultFiles.uploadedBy,
        userName: users.name,
      })
      .from(vaultFiles)
      .leftJoin(users, eq(vaultFiles.uploadedBy, users.id))
      .where(
        and(
          eq(vaultFiles.itemId, file.itemId),
          eq(vaultFiles.fileName, file.fileName),
          isNull(vaultFiles.deletedAt),
        ),
      )
      .orderBy(desc(vaultFiles.fileVersion))

    return versions.map((v) => ({
      id: v.id,
      fileVersion: v.fileVersion,
      isLatestVersion: v.isLatestVersion,
      fileName: v.fileName,
      originalFileName: v.originalFileName,
      fileSize: Number(v.fileSize),
      mimeType: v.mimeType,
      uploadedAt: v.uploadedAt,
      uploadedBy: {
        id: v.uploadedById,
        name: v.userName ?? 'Unknown User',
      },
    }))
  }

  /**
   * Get a specific file record by version number
   * Uses the provided fileId to find the file family, then returns the specific version
   */
  static async getFileByVersion(
    fileId: string,
    version: number,
  ): Promise<FileRecord | null> {
    // Get the file to find its fileName and itemId
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    // Query the specific version
    const [versionFile] = await db
      .select()
      .from(vaultFiles)
      .where(
        and(
          eq(vaultFiles.itemId, file.itemId),
          eq(vaultFiles.fileName, file.fileName),
          eq(vaultFiles.fileVersion, version),
          isNull(vaultFiles.deletedAt),
        ),
      )
      .limit(1)

    return versionFile as FileRecord | null
  }

  /**
   * Download a specific version of a file
   */
  static async downloadFileVersion(
    fileId: string,
    version: number,
    userId: string,
  ): Promise<Buffer> {
    const file = await this.getFileByVersion(fileId, version)

    if (!file) {
      throw new NotFoundError('File version', `${fileId} v${version}`)
    }

    // Get file from storage
    const storage = await this.getStorage()
    const data = await storage.retrieve(file.storagePath)

    // Log download action
    await this.logAction({
      fileId: file.id,
      action: 'download',
      performedBy: userId,
      details: {
        fileSize: data.length,
        version,
      },
    })

    return data
  }

  /**
   * Create a read stream for a specific version of a file (for large file downloads)
   */
  static async createFileVersionStream(
    fileId: string,
    version: number,
    userId: string,
  ): Promise<{ stream: ReadableStream; file: FileRecord }> {
    const file = await this.getFileByVersion(fileId, version)

    if (!file) {
      throw new NotFoundError('File version', `${fileId} v${version}`)
    }

    // Get stream from storage
    const storage = await this.getStorage()
    const stream = await storage.createReadStream(file.storagePath)

    // Log download action
    await this.logAction({
      fileId: file.id,
      action: 'download',
      performedBy: userId,
      details: {
        fileSize: file.fileSize,
        version,
        streaming: true,
      },
    })

    return { stream, file }
  }

  /**
   * List files across items with item and uploader context.
   * Used for the vault/files browser page.
   *
   * `accessScope` is the caller's reach, from
   * `AccessControlService.getAccessScope`. It draws the same boundary the
   * by-id file routes draw through `requireFileAccess`: `null`/`undefined` is
   * cross-program authority and leaves the query untouched, an empty scope
   * admits only files on the types that scope on nothing. Omitting it lists
   * the whole instance, so every caller reached from a request passes it —
   * the parameter is optional only for internal callers that have already
   * bounded their own scope.
   */
  static async listAllFiles(
    options: {
      limit?: number
      latestOnly?: boolean
      includeDeleted?: boolean
      accessScope?: AccessScope | null
    } = {},
  ): Promise<Array<FileRecordWithItem>> {
    const {
      limit = 100,
      latestOnly = true,
      includeDeleted = false,
      accessScope,
    } = options

    const conditions = [
      // Exclude thumbnail files from normal listings
      or(
        isNull(vaultFiles.fileCategory),
        ne(vaultFiles.fileCategory, 'thumbnail'),
      ),
    ]

    if (!includeDeleted) {
      conditions.push(isNull(vaultFiles.deletedAt))
    }

    if (latestOnly) {
      conditions.push(eq(vaultFiles.isLatestVersion, true))
    }

    // Also filter out files from deleted items
    conditions.push(notDeleted())

    // The query already innerJoins `items`, so the shared program boundary
    // drops straight in. Null (cross-program authority) yields no condition.
    const inScope = accessScopeCondition(accessScope)
    if (inScope) {
      conditions.push(inScope)
    }

    const files = await db
      .select({
        // File fields
        id: vaultFiles.id,
        itemId: vaultFiles.itemId,
        branchId: vaultFiles.branchId,
        fileName: vaultFiles.fileName,
        originalFileName: vaultFiles.originalFileName,
        fileSize: vaultFiles.fileSize,
        mimeType: vaultFiles.mimeType,
        fileHash: vaultFiles.fileHash,
        storageType: vaultFiles.storageType,
        storagePath: vaultFiles.storagePath,
        fileVersion: vaultFiles.fileVersion,
        isLatestVersion: vaultFiles.isLatestVersion,
        isCheckedOut: vaultFiles.isCheckedOut,
        checkedOutBy: vaultFiles.checkedOutBy,
        checkedOutAt: vaultFiles.checkedOutAt,
        uploadedBy: vaultFiles.uploadedBy,
        uploadedAt: vaultFiles.uploadedAt,
        metadata: vaultFiles.metadata,
        fileCategory: vaultFiles.fileCategory,
        categorySource: vaultFiles.categorySource,
        isPrimaryModel: vaultFiles.isPrimaryModel,
        isItemThumbnail: vaultFiles.isItemThumbnail,
        cadMetadata: vaultFiles.cadMetadata,
        deletedAt: vaultFiles.deletedAt,
        deletedBy: vaultFiles.deletedBy,
        // Item fields
        item: {
          id: items.id,
          itemNumber: items.itemNumber,
          itemType: items.itemType,
          name: items.name,
          state: items.state,
        },
        // Uploader fields
        uploader: {
          id: users.id,
          name: users.name,
          email: users.email,
        },
      })
      .from(vaultFiles)
      .innerJoin(items, eq(vaultFiles.itemId, items.id))
      .innerJoin(users, eq(vaultFiles.uploadedBy, users.id))
      .where(and(...conditions))
      .orderBy(desc(vaultFiles.uploadedAt))
      .limit(limit)

    return files as Array<FileRecordWithItem>
  }
}
