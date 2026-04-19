import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { designs } from './designs'
import { branches } from './versioning'
import { users } from './users'

/**
 * Cross-design references — lightweight links to items in other designs.
 *
 * Unlike usage-copies (which duplicate items into the target design),
 * cross-design references appear read-only in the BOM tree with their
 * full subtree visible but without creating new item records.
 *
 * Branch tracking follows the same pattern as branchItems.changeType:
 *   - branchId = NULL, changeType = NULL → on main (baseline)
 *   - branchId = X,    changeType = 'added'   → added on branch X
 *   - branchId = X,    changeType = 'deleted'  → removed on branch X
 */
export const designCrossReferences = pgTable(
  'design_cross_references',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The design that contains (displays) the reference
    referencingDesignId: uuid('referencing_design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),

    // The item being referenced (from another design)
    // References items.id — no FK to avoid circular import
    referencedItemId: uuid('referenced_item_id').notNull(),

    // The design that owns the referenced item (denormalized for efficient queries)
    sourceDesignId: uuid('source_design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),

    // Branch tracking (same pattern as branchItems)
    // NULL = on main, set = added/deleted on this branch
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'cascade',
    }),

    // NULL = baseline, 'added' | 'deleted'
    changeType: varchar('change_type', { length: 20 }),

    // Whether this reference should appear in the design structure tree
    inDesignStructure: boolean('in_design_structure').default(true),

    // Optional notes explaining why this reference exists
    notes: text('notes'),

    // Audit fields
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by').references(() => users.id),
  },
  (table) => [
    unique('design_cross_refs_unique').on(
      table.referencingDesignId,
      table.referencedItemId,
      table.branchId,
    ),
    index('idx_cross_ref_design').on(table.referencingDesignId),
    index('idx_cross_ref_item').on(table.referencedItemId),
    index('idx_cross_ref_source').on(table.sourceDesignId),
    index('idx_cross_ref_branch').on(table.branchId),
  ],
)

// Relations
export const designCrossReferencesRelations = relations(
  designCrossReferences,
  ({ one }) => ({
    referencingDesign: one(designs, {
      fields: [designCrossReferences.referencingDesignId],
      references: [designs.id],
      relationName: 'crossReferencesFrom',
    }),
    sourceDesign: one(designs, {
      fields: [designCrossReferences.sourceDesignId],
      references: [designs.id],
      relationName: 'crossReferencesTo',
    }),
    branch: one(branches, {
      fields: [designCrossReferences.branchId],
      references: [branches.id],
    }),
    createdByUser: one(users, {
      fields: [designCrossReferences.createdBy],
      references: [users.id],
      relationName: 'crossRefCreator',
    }),
    modifiedByUser: one(users, {
      fields: [designCrossReferences.modifiedBy],
      references: [users.id],
      relationName: 'crossRefModifier',
    }),
  }),
)
