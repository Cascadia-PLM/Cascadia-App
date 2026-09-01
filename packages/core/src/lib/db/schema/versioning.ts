// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { designs } from './designs'
import { users } from './users'
// Module cycle with items.ts (items references branches/commits back), and
// in-file branches⇄commits⇄tags cycles. All safe because every such
// reference sits inside a lazy `.references(() => ...)` callback, which
// defers evaluation past module load. KEEP IT THAT WAY: moving one into
// module-evaluation position crashes both editions at boot.
import { items } from './items'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

// Branches - version streams within a design
export const branches = pgTable(
  'branches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    designId: uuid('design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),

    // Identity: 'main', 'eco/ECO-2024-001', 'workspace/kai', 'release/v1.0'
    name: varchar('name', { length: 100 }).notNull(),

    // Branch type: 'main', 'eco', 'workspace', 'release'
    branchType: varchar('branch_type', { length: 20 }).notNull(),

    // Current state. NO ACTION (the default): nothing may delete a commit a
    // branch still points at, except a design deletion whose cascade removes
    // both in one statement (end-of-statement check passes).
    headCommitId: uuid('head_commit_id').references(
      (): AnyPgColumn => commits.id,
    ), // Latest commit on branch
    baseCommitId: uuid('base_commit_id').references(
      (): AnyPgColumn => commits.id,
    ), // Commit we branched from

    // For ECO branches - links to Change Order item. SET NULL: deleting a
    // draft ECO is a real flow and its branch must survive as history —
    // NO ACTION would block ECO deletion outright. (A service-level branch
    // cleanup on ECO delete is the better long-term fix; out of scope here.)
    changeOrderItemId: uuid('change_order_item_id').references(
      (): AnyPgColumn => items.id,
      { onDelete: 'set null' },
    ),

    // For workspace branches - owner
    ownerId: uuid('owner_id').references(() => users.id),

    // For release branches - source tag. SET NULL: tags are hard-deleted
    // today (DesignService.deleteTag) and blocking that is a behavior change.
    sourceTagId: uuid('source_tag_id').references((): AnyPgColumn => tags.id, {
      onDelete: 'set null',
    }),

    // Status
    isArchived: boolean('is_archived').default(false),
    isLocked: boolean('is_locked').default(false), // True when ECO submitted for approval

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    unique('branches_design_name_unique').on(table.designId, table.name),
    index('idx_branch_design').on(table.designId),
    index('idx_branch_eco').on(table.changeOrderItemId),
    index('idx_branch_owner').on(table.ownerId),
    // No index on branchType: four distinct values on a small table, and its
    // only hot read (getMainBranch) filters designId + branchType, which
    // idx_branch_design already serves.
  ],
)

// Commits - immutable snapshots
export const commits = pgTable(
  'commits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    designId: uuid('design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),
    // NO ACTION, never RESTRICT: design deletion cascades branches and
    // commits in one statement — RESTRICT's immediate check would abort it,
    // NO ACTION's end-of-statement check passes.
    branchId: uuid('branch_id')
      .notNull()
      .references((): AnyPgColumn => branches.id),

    // Parent commit (null for initial commit). NO ACTION: nothing may delete
    // a commit out from under its children — a cascade here would unzip
    // entire commit chains.
    parentId: uuid('parent_id').references((): AnyPgColumn => commits.id),

    // For merge commits - second parent
    mergeParentId: uuid('merge_parent_id').references(
      (): AnyPgColumn => commits.id,
    ),

    // Commit info
    message: text('message').notNull(),

    // Denormalized stats
    itemsChanged: integer('items_changed').default(0),
    itemsAdded: integer('items_added').default(0),
    itemsDeleted: integer('items_deleted').default(0),

    // For merge commits - reference to ECO. SET NULL, for the same reason
    // branches.change_order_item_id is: deleting a draft ECO is a real flow,
    // and NO ACTION would block it outright. A release commit is history —
    // it must survive its ECO with the linkage nulled, not vanish and not
    // hold the delete hostage. Readers already treat the pointer as optional
    // (CommitGraphService, EcoBranchHistoryService, ModelVersionService all
    // omit ecoNumber when it is null).
    changeOrderItemId: uuid('change_order_item_id').references(
      (): AnyPgColumn => items.id,
      { onDelete: 'set null' },
    ),

    // Revision info (populated on merge to main)
    // { 'P-1001': 'B', 'P-1002': 'D' }
    revisionsAssigned:
      jsonb('revisions_assigned').$type<Record<string, string>>(),

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index('idx_commit_design').on(table.designId),
    index('idx_commit_branch').on(table.branchId),
    index('idx_commit_parent').on(table.parentId),
    index('idx_commit_merge_parent').on(table.mergeParentId),
    // Mirrors idx_branch_eco, and earns its keep the same way the other
    // referencing-side indexes added with the DBI-6 FKs do: the SET NULL above
    // makes every items hard-delete look for referencing commits, which without
    // this is a seqscan of the largest table in the versioning graph.
    index('idx_commit_eco').on(table.changeOrderItemId),
    index('idx_commit_date').on(table.createdAt),
  ],
)

// Tags - named baselines
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    designId: uuid('design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),

    // Identity: 'v1.0.0', 'PDR-baseline', 'ECO-2024-001-release'
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),

    // Points to a specific commit
    commitId: uuid('commit_id')
      .notNull()
      .references(() => commits.id),

    // Tag type: 'baseline', 'release', 'milestone', 'eco-release'
    tagType: varchar('tag_type', { length: 20 }).default('baseline'),

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    unique('tags_design_name_unique').on(table.designId, table.name),
    index('idx_tag_design').on(table.designId),
    index('idx_tag_commit').on(table.commitId),
  ],
)

// Branch items - tracks items on each branch
// Note: currentItemId, baseItemId reference items.id but we avoid circular import
export const branchItems = pgTable(
  'branch_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),

    // The item being tracked (master ID)
    itemMasterId: uuid('item_master_id').notNull(),

    // Current version on this branch. NO ACTION: these are exactly the
    // pointers whose dangling the FK exists to expose — deleting an item a
    // live branch still tracks must fail loudly, not leave a ghost row.
    currentItemId: uuid('current_item_id').references(
      (): AnyPgColumn => items.id,
    ),

    // Version when branch was created (for diff calculation)
    baseItemId: uuid('base_item_id').references((): AnyPgColumn => items.id),

    // Change status: null (unchanged), 'added', 'modified', 'deleted'
    changeType: varchar('change_type', { length: 20 }),

    // Checkout status
    checkedOutBy: uuid('checked_out_by').references(() => users.id),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
  },
  (table) => [
    unique('branch_items_unique').on(table.branchId, table.itemMasterId),
    index('idx_branch_items_branch').on(table.branchId),
    index('idx_branch_items_master').on(table.itemMasterId),
    index('idx_branch_items_current_item').on(table.currentItemId),
    index('idx_branch_items_base_item').on(table.baseItemId),
    index('idx_branch_items_checkout').on(table.checkedOutBy),
  ],
)

// Item versions - links items to commits that created/modified them
// Note: itemId, previousItemId reference items.id but we avoid circular import
export const itemVersions = pgTable(
  'item_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commitId: uuid('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    // CASCADE, deliberately not NO ACTION: ItemService.update creates
    // commits + item_versions on unprotected main, and ItemService.delete of
    // such an item is a supported flow that would otherwise start throwing.
    // The items row IS the version content — once it is gone the pointer row
    // records nothing, so CASCADE mirrors today's effective semantics without
    // minting dangling rows (item_field_changes cascades along via its FK).
    //
    // Re-examined and kept. Preserving the pointer rows would preserve nothing
    // a reader can see: CommitService.getItemCommits derives per-item history
    // by selecting from `items` on masterId + designId, so the history read
    // returns [] the moment the items row is gone, whatever this FK says.
    // RESTRICT would additionally break BranchService's workspace cleanup
    // (archiveWorkspace and removeWorkspaceItem hard-delete workspace-only
    // items directly, outside ItemService). What bounds the exposure instead
    // is ItemService.requireNoRetainedEvidence, which refuses the hard delete
    // for released lineage, for a final state whose finalKind is 'release' or
    // 'complete', and for a Driving-governed item past its initial state.
    itemId: uuid('item_id')
      .notNull()
      .references((): AnyPgColumn => items.id, { onDelete: 'cascade' }),

    // What happened to this item in this commit: 'added', 'modified', 'deleted'
    changeType: varchar('change_type', { length: 20 }).notNull(),

    // Previous version (for modified items)
    previousItemId: uuid('previous_item_id').references(
      (): AnyPgColumn => items.id,
      { onDelete: 'set null' },
    ),
  },
  (table) => [
    unique('item_versions_unique').on(table.commitId, table.itemId),
    index('idx_item_versions_commit').on(table.commitId),
    index('idx_item_versions_item').on(table.itemId),
    index('idx_item_versions_previous_item').on(table.previousItemId),
  ],
)

/**
 * Item field changes - stores field-level changes for each item in each commit.
 * This enables:
 * - Rich history display ("weight: 10kg → 20kg")
 * - Field-level conflict detection (know exactly what changed on each branch)
 * - Efficient querying (no need to diff entire items)
 */
export const itemFieldChanges = pgTable(
  'item_field_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Link to the itemVersion this change belongs to
    itemVersionId: uuid('item_version_id')
      .notNull()
      .references(() => itemVersions.id, { onDelete: 'cascade' }),

    // The field that changed
    fieldName: varchar('field_name', { length: 100 }).notNull(),

    // For nested fields (e.g., attributes.customField)
    fieldPath: varchar('field_path', { length: 255 }),

    // Values as JSON (handles all types: string, number, object, array)
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),

    // Field category for filtering/grouping
    // 'core' = name, state, revision
    // 'type' = type-specific fields (weight, material, etc.)
    // 'attribute' = custom attributes
    // 'relationship' = BOM/reference changes
    fieldCategory: varchar('field_category', { length: 20 }).default('core'),
  },
  (table) => [
    index('idx_field_changes_version').on(table.itemVersionId),
    index('idx_field_changes_field').on(table.fieldName),
  ],
)

// Relations
export const branchesRelations = relations(branches, ({ one, many }) => ({
  design: one(designs, {
    fields: [branches.designId],
    references: [designs.id],
  }),
  headCommit: one(commits, {
    fields: [branches.headCommitId],
    references: [commits.id],
    relationName: 'branchHead',
  }),
  baseCommit: one(commits, {
    fields: [branches.baseCommitId],
    references: [commits.id],
    relationName: 'branchBase',
  }),
  owner: one(users, {
    fields: [branches.ownerId],
    references: [users.id],
  }),
  commits: many(commits),
  branchItems: many(branchItems),
}))

export const commitsRelations = relations(commits, ({ one, many }) => ({
  design: one(designs, {
    fields: [commits.designId],
    references: [designs.id],
  }),
  branch: one(branches, {
    fields: [commits.branchId],
    references: [branches.id],
  }),
  parent: one(commits, {
    fields: [commits.parentId],
    references: [commits.id],
    relationName: 'commitParent',
  }),
  mergeParent: one(commits, {
    fields: [commits.mergeParentId],
    references: [commits.id],
    relationName: 'commitMergeParent',
  }),
  author: one(users, {
    fields: [commits.createdBy],
    references: [users.id],
  }),
  itemVersions: many(itemVersions),
}))

export const tagsRelations = relations(tags, ({ one }) => ({
  design: one(designs, {
    fields: [tags.designId],
    references: [designs.id],
  }),
  commit: one(commits, {
    fields: [tags.commitId],
    references: [commits.id],
  }),
  createdByUser: one(users, {
    fields: [tags.createdBy],
    references: [users.id],
  }),
}))

export const branchItemsRelations = relations(branchItems, ({ one }) => ({
  branch: one(branches, {
    fields: [branchItems.branchId],
    references: [branches.id],
  }),
  checkedOutByUser: one(users, {
    fields: [branchItems.checkedOutBy],
    references: [users.id],
  }),
  // Note: currentItem and baseItem relations to items are defined in items.ts
}))

export const itemVersionsRelations = relations(
  itemVersions,
  ({ one, many }) => ({
    commit: one(commits, {
      fields: [itemVersions.commitId],
      references: [commits.id],
    }),
    fieldChanges: many(itemFieldChanges),
    // Note: item and previousItem relations to items are defined in items.ts
  }),
)

export const itemFieldChangesRelations = relations(
  itemFieldChanges,
  ({ one }) => ({
    itemVersion: one(itemVersions, {
      fields: [itemFieldChanges.itemVersionId],
      references: [itemVersions.id],
    }),
  }),
)

// Conflict reviews - tracks which warning conflicts have been acknowledged.
// Append-only: every acknowledgement is its own row, so re-acknowledging a
// conflict preserves the previous reviewer's note and timestamp. The current
// acknowledgement for a conflict is the newest row for its
// (changeOrderId, itemMasterId, conflictType, theirEcoId) key.
// Note: changeOrderId and theirEcoId reference items.id but we avoid circular import
export const conflictReviews = pgTable(
  'conflict_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The ECO this conflict belongs to. CASCADE: ECO-scoped acknowledgments
    // die with the ECO.
    changeOrderId: uuid('change_order_id')
      .notNull()
      .references((): AnyPgColumn => items.id, { onDelete: 'cascade' }),

    // The item master ID involved in the conflict
    itemMasterId: uuid('item_master_id').notNull(),

    // The type of conflict: 'concurrent_modification', 'cross_eco'
    conflictType: varchar('conflict_type', { length: 50 }).notNull(),

    // For cross_eco conflicts - the other ECO's item ID
    theirEcoId: uuid('their_eco_id').references((): AnyPgColumn => items.id, {
      onDelete: 'set null',
    }),

    // Hash of conflict details to detect when conflict has changed
    conflictSignature: varchar('conflict_signature', { length: 64 }).notNull(),

    // Who reviewed this conflict
    reviewedBy: uuid('reviewed_by')
      .notNull()
      .references(() => users.id),

    // When it was reviewed
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),

    // Optional notes from the reviewer
    notes: text('notes'),
  },
  (table) => [
    index('idx_conflict_reviews_change_order').on(table.changeOrderId),
    index('idx_conflict_reviews_item').on(table.itemMasterId),
    index('idx_conflict_reviews_their_eco').on(table.theirEcoId),
    index('idx_conflict_reviews_reviewer').on(table.reviewedBy),
  ],
)

export const conflictReviewsRelations = relations(
  conflictReviews,
  ({ one }) => ({
    reviewer: one(users, {
      fields: [conflictReviews.reviewedBy],
      references: [users.id],
    }),
    // Note: changeOrder and theirEco relations to items are defined in items.ts
  }),
)
