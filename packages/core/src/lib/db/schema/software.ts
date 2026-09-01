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
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { items } from './items'
import { users } from './users'

// ============================================================================
// Software - firmware/embedded software as a first-class item type
//
// Internal-mode source trees are stored content-addressed: deduplicated blobs
// (software_blobs, keyed by SHA-256) referenced from immutable tree snapshots
// (software_manifests). The `software` extension row points at the manifest
// for that item VERSION, so version pinning rides the items master/instance
// pattern with no extra resolution logic.
// See docs/features/software-management.md.
// ============================================================================

/** A single file entry within a manifest snapshot. */
export interface SoftwareManifestEntry {
  path: string
  hash: string
  size: number
}

/**
 * An immutable snapshot of an entire source tree.
 * Never mutated after creation - edits produce a new manifest.
 */
export const softwareManifests = pgTable('software_manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Flat path list - no directory objects needed at firmware scale.
  entries: jsonb('entries').$type<Array<SoftwareManifestEntry>>().notNull(),
  fileCount: integer('file_count').notNull(),
  totalSize: bigint('total_size', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
})

/**
 * Deduplicated file contents, keyed by SHA-256 of the content.
 * Shared across versions, items, and designs - storage cost is proportional
 * to change, like git. Text content is stored inline; binary content is
 * stored base64-encoded (small files only). vault_file_id is reserved for
 * spilling large files to the vault in a later phase.
 */
export const softwareBlobs = pgTable('software_blobs', {
  hash: varchar('hash', { length: 64 }).primaryKey(),
  content: text('content'),
  vaultFileId: uuid('vault_file_id'),
  size: integer('size').notNull(),
  isBinary: boolean('is_binary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

/**
 * Software - type-specific table following the two-table pattern.
 * Extends items with software configuration-item fields.
 */
export const software = pgTable(
  'software',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    description: text('description'),
    // 'firmware' | 'application' | 'library' | 'configuration' | 'fpga'
    softwareType: varchar('software_type', { length: 30 }),
    // 'internal' (source lives in Cascadia) | 'external' (pinned repo ref)
    sourceMode: varchar('source_mode', { length: 20 })
      .notNull()
      .default('internal'),

    // Lightweight external mode: manually maintained repository pin. A later
    // provider-integration phase may replace these with a softwareRepoLink.
    externalRepositoryUrl: text('external_repository_url'),
    externalRef: varchar('external_ref', { length: 300 }),
    externalCommitSha: varchar('external_commit_sha', { length: 64 }),

    // Version metadata (user-managed, distinct from the PLM revision letter)
    version: varchar('version', { length: 50 }),
    targetHardware: varchar('target_hardware', { length: 200 }),
    toolchain: varchar('toolchain', { length: 200 }),

    // Internal mode: the immutable source-tree snapshot for THIS item version
    manifestId: uuid('manifest_id').references(() => softwareManifests.id),

    // In-progress edits on a working copy: saved without a commit, promoted
    // to manifestId by an explicit commit (with message), discarded on
    // release. Never copied to new versions and never in field history.
    draftManifestId: uuid('draft_manifest_id').references(
      () => softwareManifests.id,
    ),

    // Primary build artifact (vault file: .bin/.hex/.elf/.exe/.zip)
    buildArtifactFileId: uuid('build_artifact_file_id'),
  },
  (table) => [index('idx_software_manifest').on(table.manifestId)],
)

export const softwareRelations = relations(software, ({ one }) => ({
  item: one(items, {
    fields: [software.itemId],
    references: [items.id],
  }),
  manifest: one(softwareManifests, {
    fields: [software.manifestId],
    references: [softwareManifests.id],
  }),
}))

export const softwareManifestsRelations = relations(
  softwareManifests,
  ({ one }) => ({
    createdByUser: one(users, {
      fields: [softwareManifests.createdBy],
      references: [users.id],
    }),
  }),
)

export type SoftwareRow = typeof software.$inferSelect
export type SoftwareManifest = typeof softwareManifests.$inferSelect
export type SoftwareBlob = typeof softwareBlobs.$inferSelect
