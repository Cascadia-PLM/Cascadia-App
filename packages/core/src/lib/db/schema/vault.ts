// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { users } from './users'
import { items } from './items'
import { branches } from './versioning'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

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
    // Whether fileCategory was guessed from the filename at upload ('auto') or
    // set by a person ('manual'). A manual category is authoritative: nothing
    // re-detects over it, not even a new version uploaded on check-in.
    categorySource: varchar('category_source', { length: 20 })
      .notNull()
      .default('auto'),
    isPrimaryModel: boolean('is_primary_model').default(false), // Mark primary CAD file for quick access
    // User-designated item thumbnail. Set on an uploaded image file to make that
    // image the item's thumbnail; takes precedence over the CAD-converter-generated
    // thumbnail referenced by thumbnailFileId. At most one per item, enforced
    // by uq_vault_files_item_thumbnail below.
    isItemThumbnail: boolean('is_item_thumbnail').notNull().default(false),
    cadMetadata: jsonb('cad_metadata').$type<{
      software?: string // e.g., 'SolidWorks 2024', 'Fusion360'
      units?: string // e.g., 'mm', 'in', 'ft'
      polygonCount?: number // For mesh files (STL, OBJ)
      boundingBox?: { x: number; y: number; z: number } // Model dimensions
      hasColors?: boolean // Per-face colors preserved (GLB written by the CAD converter)
      /**
       * The separately-addressable parts of a structured assembly GLB, in the
       * order the converter wrote their glTF nodes.
       *
       * Present only on a GLB the converter wrote a node per leaf part into,
       * which is what makes a model selectable in the viewer. Absent on a
       * single part, on any non-STEP source, and on every assembly converted
       * before the structured writer existed — all of which are flat meshes
       * with nothing to pick apart. So `nodes?.length` is the honest test for
       * "can this model be taken apart", and re-running the conversion is
       * what earns an older file the capability.
       */
      nodes?: Array<{
        /** glTF node name; unique in the file, stable across re-conversion. */
        nodeKey: string
        /** The part's name as its CAD authored it. Not unique. */
        name: string
        /** Instance path from the assembly root down to this part. */
        path: Array<string>
        polygonCount?: number
      }>
    }>(),

    // The generated thumbnail of this file, itself a vault file. A real
    // self-FK, not a bare uuid: nothing in the app hard-deletes a vault_files
    // row today, but a future hard delete or an operator's manual cleanup
    // would otherwise leave `getItemThumbnailFileId` handing out an id that
    // 404s. SET NULL, so the referrer survives its thumbnail and simply has
    // none.
    thumbnailFileId: uuid('thumbnail_file_id').references(
      (): AnyPgColumn => vaultFiles.id,
      { onDelete: 'set null' },
    ),

    deletedAt: timestamp('deleted_at', { withTimezone: true }), // Soft delete
    deletedBy: uuid('deleted_by').references(() => users.id),
  },
  (table) => [
    index('idx_vault_files_item_id').on(table.itemId),
    index('idx_vault_files_branch_id').on(table.branchId),
    index('idx_vault_files_hash').on(table.fileHash),
    index('idx_vault_files_checked_out_by').on(table.checkedOutBy),
    // Partial, on itemId: FileService always asks "the latest version of this
    // item's files", never "every latest-version row in the instance". A
    // two-value btree over the whole table answered neither.
    index('idx_vault_files_latest')
      .on(table.itemId)
      .where(sql`${table.isLatestVersion}`),
    index('idx_vault_files_deleted').on(table.deletedAt),
    index('idx_vault_files_category').on(table.fileCategory),
    // Partial, on itemId, for the same reason: the primary model is looked up
    // per item. Nullable, so the predicate has to be explicit rather than a
    // bare column reference.
    index('idx_vault_files_primary')
      .on(table.itemId)
      .where(sql`${table.isPrimaryModel}`),
    // On the pointer column, and kept: it is what the self-FK's SET NULL scan
    // reads when a thumbnail file is hard-deleted.
    index('idx_vault_files_thumbnail').on(table.thumbnailFileId),
    // Partial and unique, on itemId: "at most one thumbnail per item" was a
    // comment the database did nothing about, and the index that stood here
    // was a bare whole-table boolean btree — two values over every row, which
    // answered no query anyone asks. One declaration now enforces the
    // invariant and serves the per-item lookup.
    uniqueIndex('uq_vault_files_item_thumbnail')
      .on(table.itemId)
      .where(sql`${table.isItemThumbnail}`),
  ],
)

export const vaultFileHistory = pgTable(
  'vault_file_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => vaultFiles.id, { onDelete: 'cascade' }),
    action: varchar('action', { length: 50 }).notNull(), // 'upload', 'download', 'checkout', 'checkin', 'delete', 'restore', 'set_primary', 'set_thumbnail', 'clear_thumbnail'
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

/**
 * Markup drawn on a file in the in-app viewer.
 *
 * Kept as PLM data rather than burned into the PDF on purpose: a vault file
 * version is immutable, so writing markup back into the bytes would mint a new
 * version on every stroke and break the hash recorded at upload. Storing it
 * beside the file means markup is queryable, attributable, and revisable, and
 * can still be flattened into a PDF on demand.
 *
 * Annotations hang off a `vault_files` row — that is, off one *version* of one
 * file — so branch visibility and file versioning come for free: markup drawn
 * on an ECO branch is only visible where that file version is.
 *
 * Geometry is stored in normalized page coordinates (0..1 from the top-left of
 * the unrotated page), so it survives zooming, rotation, and rendering at any
 * device pixel ratio.
 */
export const vaultFileAnnotations = pgTable(
  'vault_file_annotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => vaultFiles.id, { onDelete: 'cascade' }),
    /**
     * Denormalized from the file so the access check (item -> design) and
     * "all markup on this item" queries do not need a join.
     */
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),

    /** 1-based page the markup sits on. */
    pageNumber: integer('page_number').notNull(),
    /** 'highlight' | 'rect' | 'ink' | 'note' | 'text' */
    kind: varchar('kind', { length: 20 }).notNull(),
    /** Normalized geometry; shape depends on `kind`. See `@/lib/vault/annotations`. */
    geometry: jsonb('geometry').notNull(),
    /** Stroke/fill colour as a hex string, e.g. '#f59e0b'. */
    color: varchar('color', { length: 9 }).notNull(),
    /** The comment or label carried by the markup. */
    contents: text('contents'),

    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_vault_annotations_file').on(table.fileId, table.pageNumber),
    index('idx_vault_annotations_item').on(table.itemId),
    index('idx_vault_annotations_author').on(table.authorId),
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
  annotations: many(vaultFileAnnotations),
}))

export const vaultFileAnnotationsRelations = relations(
  vaultFileAnnotations,
  ({ one }) => ({
    file: one(vaultFiles, {
      fields: [vaultFileAnnotations.fileId],
      references: [vaultFiles.id],
    }),
    item: one(items, {
      fields: [vaultFileAnnotations.itemId],
      references: [items.id],
    }),
    author: one(users, {
      fields: [vaultFileAnnotations.authorId],
      references: [users.id],
    }),
  }),
)

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

// ============================================================================
// CAD model node links — which PLM part a node in an assembly model *is*
// ============================================================================

/**
 * Binds one selectable node of a structured assembly GLB to the Part it
 * represents, so clicking a bracket in the 3D view can open that bracket's
 * detail page.
 *
 * Both sides are `masterId`s rather than item or file ids, which is what makes
 * a link outlive the things it was made from. A re-conversion replaces the GLB
 * with a new `vault_files` row; a revision replaces the assembly and the child
 * with new `items` rows. Neither changes what the bracket in the corner of the
 * model is, so neither should cost the link — and keying on a file id would
 * have thrown the whole mapping away on the first re-convert, which is exactly
 * when a large assembly is most expensive to re-link by hand.
 *
 * **Every row here is a person's correction.** Nothing writes the matches it
 * can work out for itself: names are matched against the assembly's BOM on
 * each read instead, which costs a string comparison per child and is always
 * current — a part added to the BOM this morning is matched this morning,
 * where saved auto-matches would have gone stale the moment the BOM moved and
 * left no way to tell a stale guess from a considered answer. So a node with
 * no row is not "unresolved", it is "whatever the matcher says", and this
 * table only ever overrides that.
 *
 * `partMasterId` is nullable on purpose, and is not the same as a missing row:
 * it is how someone records that a node is deliberately *not* a BOM part — a
 * fixture, a weld bead, packaging the CAD carries — which both suppresses the
 * matcher's guess and stops it being proposed again.
 */
export const cadModelNodeLinks = pgTable(
  'cad_model_node_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // items.masterId of the assembly Part — lineage reference, deliberately
    // not an FK to a single version row.
    assemblyMasterId: uuid('assembly_master_id').notNull(),
    // glTF node name, as `cadMetadata.nodes[].nodeKey` carries it.
    nodeKey: text('node_key').notNull(),
    // items.masterId of the linked Part; null records "not a part" (see above).
    partMasterId: uuid('part_master_id'),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // One override per node — what the editor's upsert targets.
    uniqueIndex('uq_cad_model_node_links_node').on(
      table.assemblyMasterId,
      table.nodeKey,
    ),
    // Reading an assembly's links is the only read anyone does, and it always
    // asks for all of them at once — so the unique index above already serves
    // it, and there is deliberately no second index on assemblyMasterId alone.
    // This one answers the other direction: "which assemblies place this part".
    index('idx_cad_model_node_links_part').on(table.partMasterId),
  ],
)

export const cadModelNodeLinksRelations = relations(
  cadModelNodeLinks,
  ({ one }) => ({
    creator: one(users, {
      fields: [cadModelNodeLinks.createdBy],
      references: [users.id],
    }),
  }),
)
