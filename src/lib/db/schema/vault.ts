import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'
import { items } from './items'
import { branches } from './versioning'

export const vaultFiles = pgTable(
  'vault_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'set null',
    }), // Branch file was uploaded on (null = visible everywhere)
    fileName: text('file_name').notNull(), // Sanitized filename for storage
    originalFileName: text('original_file_name').notNull(), // User's original filename
    fileSize: bigint('file_size', { mode: 'number' }).notNull(), // In bytes
    mimeType: varchar('mime_type', { length: 200 }).notNull(),
    fileHash: varchar('file_hash', { length: 64 }).notNull(), // SHA256 hash
    storageType: varchar('storage_type', { length: 50 })
      .notNull()
      .default('local'), // 'local', 's3', etc.
    storagePath: text('storage_path').notNull(), // Relative path from vault root
    fileVersion: integer('file_version').notNull().default(1), // Version number for this file
    isLatestVersion: boolean('is_latest_version').notNull().default(true), // Current version flag
    isCheckedOut: boolean('is_checked_out').notNull().default(false), // Lock status
    checkedOutBy: uuid('checked_out_by').references(() => users.id),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    metadata: jsonb('metadata'), // Extracted metadata, file description

    // File categorization for different file types
    fileCategory: varchar('file_category', { length: 50 }), // 'cad_model', 'drawing', 'specification', 'analysis', 'reference', 'other'
    isPrimaryModel: boolean('is_primary_model').default(false), // Mark primary CAD file for quick access
    cadMetadata: jsonb('cad_metadata').$type<{
      software?: string // e.g., 'SolidWorks 2024', 'Fusion360'
      units?: string // e.g., 'mm', 'in', 'ft'
      polygonCount?: number // For mesh files (STL, OBJ)
      boundingBox?: { x: number; y: number; z: number } // Model dimensions
    }>(),

    thumbnailFileId: uuid('thumbnail_file_id'), // Self-referencing FK added via raw SQL migration

    deletedAt: timestamp('deleted_at', { withTimezone: true }), // Soft delete
    deletedBy: uuid('deleted_by').references(() => users.id),
  },
  (table) => [
    index('idx_vault_files_item_id').on(table.itemId),
    index('idx_vault_files_branch_id').on(table.branchId),
    index('idx_vault_files_hash').on(table.fileHash),
    index('idx_vault_files_checked_out_by').on(table.checkedOutBy),
    index('idx_vault_files_latest').on(table.isLatestVersion),
    index('idx_vault_files_deleted').on(table.deletedAt),
    index('idx_vault_files_category').on(table.fileCategory),
    index('idx_vault_files_primary').on(table.isPrimaryModel),
    index('idx_vault_files_thumbnail').on(table.thumbnailFileId),
  ],
)

export const vaultFileHistory = pgTable(
  'vault_file_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => vaultFiles.id, { onDelete: 'cascade' }),
    action: varchar('action', { length: 50 }).notNull(), // 'upload', 'download', 'checkout', 'checkin', 'delete', 'restore'
    performedBy: uuid('performed_by')
      .notNull()
      .references(() => users.id),
    performedAt: timestamp('performed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    details: jsonb('details'), // Action-specific data (IP, user agent, version changes, etc.)
  },
  (table) => [
    index('idx_vault_history_file_id').on(table.fileId),
    index('idx_vault_history_performed_by').on(table.performedBy),
    index('idx_vault_history_performed_at').on(table.performedAt),
  ],
)

// Relations
export const vaultFilesRelations = relations(vaultFiles, ({ one, many }) => ({
  item: one(items, {
    fields: [vaultFiles.itemId],
    references: [items.id],
  }),
  branch: one(branches, {
    fields: [vaultFiles.branchId],
    references: [branches.id],
  }),
  uploader: one(users, {
    fields: [vaultFiles.uploadedBy],
    references: [users.id],
    relationName: 'fileUploader',
  }),
  checkedOutUser: one(users, {
    fields: [vaultFiles.checkedOutBy],
    references: [users.id],
    relationName: 'fileCheckedOutUser',
  }),
  deleter: one(users, {
    fields: [vaultFiles.deletedBy],
    references: [users.id],
    relationName: 'fileDeleter',
  }),
  thumbnail: one(vaultFiles, {
    fields: [vaultFiles.thumbnailFileId],
    references: [vaultFiles.id],
    relationName: 'fileThumbnail',
  }),
  history: many(vaultFileHistory),
}))

export const vaultFileHistoryRelations = relations(
  vaultFileHistory,
  ({ one }) => ({
    file: one(vaultFiles, {
      fields: [vaultFileHistory.fileId],
      references: [vaultFiles.id],
    }),
    performer: one(users, {
      fields: [vaultFileHistory.performedBy],
      references: [users.id],
    }),
  }),
)
