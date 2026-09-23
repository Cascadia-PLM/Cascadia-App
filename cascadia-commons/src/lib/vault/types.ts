// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Vault wire types — the file record the files API returns and the effective
 * storage configuration the admin page shows. Declared apart from
 * `FileService` and the storage factory so the web package can name them;
 * both re-export.
 */

/**
 * Information about the effective vault configuration
 */
export interface VaultConfigInfo {
  type: 'local' | 's3'
  // Local storage fields
  rootPath?: string
  // S3 storage fields
  bucket?: string
  region?: string
  keyPrefix?: string
  endpoint?: string
  forcePathStyle?: boolean
  hasCredentials: boolean
  // Source tracking for each field
  sources: {
    type: 'env' | 'default'
    rootPath?: 'env' | 'db' | 'default'
    bucket?: 'env'
    region?: 'env' | 'default'
    keyPrefix?: 'env'
    endpoint?: 'env'
  }
  // Raw environment variable presence flags
  envVars: {
    VAULT_TYPE: boolean
    VAULT_ROOT: boolean
    S3_BUCKET: boolean
    S3_REGION: boolean
    S3_KEY_PREFIX: boolean
    S3_ENDPOINT: boolean
    S3_ACCESS_KEY_ID: boolean
    S3_SECRET_ACCESS_KEY: boolean
    S3_FORCE_PATH_STYLE: boolean
  }
  // Database overrides
  dbSettings: {
    vaultRoot?: string
  }
}

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
