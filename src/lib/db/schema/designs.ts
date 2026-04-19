import {
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
import { programs } from './programs'
import { users } from './users'

/**
 * Design type values:
 * - 'Engineering': Engineering design containing EBOM
 * - 'Manufacturing': Manufacturing design containing MBOM, derived from Engineering
 * - 'Library': Standard Library (globally accessible)
 * - 'Family': Container for related designs
 */
export type DesignType = 'Engineering' | 'Manufacturing' | 'Library' | 'Family'

export const designs = pgTable(
  'designs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Program association (null for Standard Library which is globally accessible)
    programId: uuid('program_id').references(() => programs.id, {
      onDelete: 'set null',
    }),

    // Identity
    name: varchar('name', { length: 200 }).notNull(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    description: text('description'),

    // Design type: 'Engineering' for normal designs, 'Library' for Standard Library, 'Family' for containers
    designType: varchar('design_type', { length: 50 })
      .notNull()
      .default('Engineering'),

    // Parent design for hierarchy (family → design relationship)
    // Only family-type designs can be parents
    parentDesignId: uuid('parent_design_id'),

    // Clone source design (for traceability when design is cloned)
    cloneSourceDesignId: uuid('clone_source_design_id'),

    // MBOM source tracking (for Manufacturing designs derived from Engineering)
    // The source Engineering design this MBOM was derived from
    sourceDesignId: uuid('source_design_id'),
    // The specific tag/baseline used as the derivation point
    sourceTagId: uuid('source_tag_id'),
    // The specific commit used as the derivation point (if no tag specified)
    sourceCommitId: uuid('source_commit_id'),

    // Planning info
    plannedQuantity: integer('planned_quantity'),

    // Default branch (usually main, set after creation)
    // Note: This is a forward reference - the branches table references designs
    defaultBranchId: uuid('default_branch_id'),

    // Status
    isArchived: boolean('is_archived').default(false),

    // SysML API compatibility
    sysmlProjectId: uuid('sysml_project_id'), // For external tool sync

    // Flexible custom attributes
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .default({}),

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (table) => [
    index('idx_design_program').on(table.programId),
    index('idx_design_type').on(table.designType),
    index('idx_design_parent').on(table.parentDesignId),
    index('idx_design_clone_source').on(table.cloneSourceDesignId),
    index('idx_design_source').on(table.sourceDesignId),
    index('idx_design_attributes').using('gin', table.attributes),
  ],
)

export const designsRelations = relations(designs, ({ one, many }) => ({
  program: one(programs, {
    fields: [designs.programId],
    references: [programs.id],
  }),
  createdByUser: one(users, {
    fields: [designs.createdBy],
    references: [users.id],
    relationName: 'designCreator',
  }),
  updatedByUser: one(users, {
    fields: [designs.updatedBy],
    references: [users.id],
    relationName: 'designUpdater',
  }),
  // Hierarchy relations for family → design structure
  parentDesign: one(designs, {
    fields: [designs.parentDesignId],
    references: [designs.id],
    relationName: 'designHierarchy',
  }),
  childDesigns: many(designs, { relationName: 'designHierarchy' }),
  // Clone source relation (for designs created via cloning)
  cloneSourceDesign: one(designs, {
    fields: [designs.cloneSourceDesignId],
    references: [designs.id],
    relationName: 'designClones',
  }),
  clonedDesigns: many(designs, { relationName: 'designClones' }),
  // MBOM source relation (for Manufacturing designs derived from Engineering)
  sourceDesign: one(designs, {
    fields: [designs.sourceDesignId],
    references: [designs.id],
    relationName: 'derivedDesigns',
  }),
  derivedDesigns: many(designs, { relationName: 'derivedDesigns' }),
  // Note: branches, items, and defaultBranch relations are defined in versioning.ts
  // to avoid circular dependency issues
}))
