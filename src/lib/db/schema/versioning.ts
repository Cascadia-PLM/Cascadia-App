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

    // Current state
    headCommitId: uuid('head_commit_id'), // Latest commit on branch
    baseCommitId: uuid('base_commit_id'), // Commit we branched from

    // For ECO branches - links to Change Order item
    changeOrderItemId: uuid('change_order_item_id'),

    // For workspace branches - owner
    ownerId: uuid('owner_id').references(() => users.id),

    // For release branches - source tag
    sourceTagId: uuid('source_tag_id'),

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
    index('idx_branch_type').on(table.branchType),
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
    branchId: uuid('branch_id').notNull(), // References branches.id - set separately to avoid circular ref

    // Parent commit (null for initial commit)
    parentId: uuid('parent_id'),

    // For merge commits - second parent
    mergeParentId: uuid('merge_parent_id'),

    // Commit info
    message: text('message').notNull(),

    // Denormalized stats
    itemsChanged: integer('items_changed').default(0),
    itemsAdded: integer('items_added').default(0),
    itemsDeleted: integer('items_deleted').default(0),

    // For merge commits - reference to ECO
    changeOrderItemId: uuid('change_order_item_id'),

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

    // Current version on this branch (references items.id)
    currentItemId: uuid('current_item_id'),

    // Version when branch was created (for diff calculation, references items.id)
    baseItemId: uuid('base_item_id'),

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
    itemId: uuid('item_id').notNull(), // References items.id

    // What happened to this item in this commit: 'added', 'modified', 'deleted'
    changeType: varchar('change_type', { length: 20 }).notNull(),

    // Previous version (for modified items, references items.id)
    previousItemId: uuid('previous_item_id'),
  },
  (table) => [
    unique('item_versions_unique').on(table.commitId, table.itemId),
    index('idx_item_versions_commit').on(table.commitId),
    index('idx_item_versions_item').on(table.itemId),
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

// Conflict reviews - tracks which warning conflicts have been acknowledged
// Note: changeOrderId and theirEcoId reference items.id but we avoid circular import
export const conflictReviews = pgTable(
  'conflict_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The ECO this conflict belongs to (references items.id for change order)
    changeOrderId: uuid('change_order_id').notNull(),

    // The item master ID involved in the conflict
    itemMasterId: uuid('item_master_id').notNull(),

    // The type of conflict: 'concurrent_modification', 'cross_eco'
    conflictType: varchar('conflict_type', { length: 50 }).notNull(),

    // For cross_eco conflicts - the other ECO's item ID (references items.id)
    theirEcoId: uuid('their_eco_id'),

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
    unique('conflict_reviews_unique').on(
      table.changeOrderId,
      table.itemMasterId,
      table.conflictType,
      table.theirEcoId,
    ),
    index('idx_conflict_reviews_change_order').on(table.changeOrderId),
    index('idx_conflict_reviews_item').on(table.itemMasterId),
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
