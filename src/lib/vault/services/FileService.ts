// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, desc, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'
import { db } from '../../db'
import { items, users, vaultFileHistory, vaultFiles } from '../../db/schema'
import { StorageFactory } from '../storage'
import {
  detectFileCategory,
  extractFileMetadata,
  generateFileHash,
  generateStoragePath,
  getFileExtension,
  isFileTypeAllowed,
  sanitizeFilename,
  validateFileSize,
} from '../utils'
import { CommitService } from '../../services/CommitService'
import { BranchService } from '../../services/BranchService'
import { ItemService } from '../../items/services/ItemService'
import type { FileUploadMetadata, VaultStorage } from '../storage'
import { vaultLogger } from '@/lib/logging/logger'
import {
  AlreadyExistsError,
  FileTooLargeError,
  FileTypeNotAllowedError,
  InternalError,
  NotFoundError,
  PermissionDeniedError,
  ResourceLockedError,
  ValidationError,
} from '@/lib/errors'

export interface CadMetadata {
  software?: string // e.g., 'SolidWorks 2024', 'Fusion360'
  units?: string // e.g., 'mm', 'in', 'ft'
  polygonCount?: number // For mesh files (STL, OBJ)
  boundingBox?: { x: number; y: number; z: number } // Model dimensions
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
  isPrimaryModel: boolean
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
    } = options

    // Validate file size
    if (!validateFileSize(file.length, maxSizeBytes)) {
      throw new FileTooLargeError(maxSizeBytes, file.length)
    }

    // Validate file type
    if (!isFileTypeAllowed(metadata.originalFileName, metadata.mimeType)) {
      const ext = getFileExtension(metadata.originalFileName)
      throw new FileTypeNotAllowedError(ext || metadata.mimeType, [
        '.step',
        '.stp',
        '.iges',
        '.stl',
        '.obj',
        '.pdf',
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.csv',
        '.png',
        '.jpg',
        '.jpeg',
        '.zip',
      ])
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

    // Insert file record
    const [fileRecord] = await db
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
      })
      .returning()

    // Log upload action
    await this.logAction({
      fileId,
      action: 'upload',
      performedBy: uploadedBy,
      details: {
        originalFileName: metadata.originalFileName,
        fileSize: file.length,
        mimeType: metadata.mimeType,
      },
    })

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
   */
  static async downloadFile(fileId: string, userId: string): Promise<Buffer> {
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

    // Log download action
    await this.logAction({
      fileId,
      action: 'download',
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

    // Log download action
    await this.logAction({
      fileId,
      action: 'download',
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
  static async promoteFilesToMain(branchId: string): Promise<number> {
    const result = await db
      .update(vaultFiles)
      .set({ branchId: null })
      .where(eq(vaultFiles.branchId, branchId))
      .returning({ id: vaultFiles.id })

    return result.length
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
   * Check out a file (lock for editing)
   */
  static async checkOutFile(fileId: string, userId: string): Promise<void> {
    const file = await this.getFileMetadata(fileId)

    if (!file) {
      throw new NotFoundError('File', fileId)
    }

    if (file.deletedAt) {
      throw new ValidationError('Cannot check out a deleted file')
    }

    if (file.isCheckedOut) {
      // Auto-release expired locks
      if (FileService.isLockExpired(file.checkedOutAt)) {
        await FileService.forceReleaseLock(fileId, userId, 'auto-expired')
      } else {
        throw new ResourceLockedError(
          'File',
          `Already checked out by user ${file.checkedOutBy}`,
        )
      }
    }

    // Check out file
    await db
      .update(vaultFiles)
      .set({
        isCheckedOut: true,
        checkedOutBy: userId,
        checkedOutAt: new Date(),
      })
      .where(eq(vaultFiles.id, fileId))

    // Log checkout action
    await this.logAction({
      fileId,
      action: 'checkout',
      performedBy: userId,
      details: {
        originalFileName: file.originalFileName,
      },
    })
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

      // Mark current version as not latest
      await db
        .update(vaultFiles)
        .set({ isLatestVersion: false })
        .where(eq(vaultFiles.id, fileId))

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

      // Store new version
      const storage = await this.getStorage()
      await storage.store(storagePath, newFileData)

      const extractedMetadata = await extractFileMetadata(
        metadata.originalFileName,
        metadata.mimeType,
        newFileData,
      )

      // Insert new version record (preserve branchId from original file)
      const [newRecord] = await db
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
        })
        .returning()

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
      const type = file.mimeType.split('/')[0]
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
   * Get the thumbnail file ID for an item.
   * Checks primary model first, then falls back to any file with a thumbnail.
   */
  static async getItemThumbnailFileId(itemId: string): Promise<string | null> {
    // First try the primary model
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
   * List all files across all items with item and uploader context
   * Used for the vault/files browser page
   */
  static async listAllFiles(
    options: {
      limit?: number
      latestOnly?: boolean
      includeDeleted?: boolean
    } = {},
  ): Promise<Array<FileRecordWithItem>> {
    const { limit = 100, latestOnly = true, includeDeleted = false } = options

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
    conditions.push(eq(items.isDeleted, false))

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
        isPrimaryModel: vaultFiles.isPrimaryModel,
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
