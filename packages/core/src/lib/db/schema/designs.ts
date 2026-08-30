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
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { programs } from './programs'
import { users } from './users'
// Module cycle with versioning.ts (branches/commits/tags reference designs
// back). Safe because every cross-file table reference here sits inside a
// lazy `.references(() => ...)` callback, which defers evaluation past both
// modules' load. KEEP IT THAT WAY: moving one of these references into
// module-evaluation position crashes both editions at boot.
import { branches, commits, tags } from './versioning'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

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
    // Only family-type designs can be parents. SET NULL: children outlive a
    // deleted family container.
    parentDesignId: uuid('parent_design_id').references(
      (): AnyPgColumn => designs.id,
      { onDelete: 'set null' },
    ),

    // Clone source design (for traceability when design is cloned).
    // SET NULL: provenance, not ownership.
    cloneSourceDesignId: uuid('clone_source_design_id').references(
      (): AnyPgColumn => designs.id,
      { onDelete: 'set null' },
    ),

    // MBOM source tracking (for Manufacturing designs derived from Engineering)
    // The source Engineering design this MBOM was derived from.
    // SET NULL throughout: these are CROSS-design edges — deleting the source
    // Engineering design cascades its commits/tags, and NO ACTION would make
    // any Engineering design with a derived MBOM undeletable. SET NULL keeps
    // deletability at the cost of derivation provenance.
    sourceDesignId: uuid('source_design_id').references(
      (): AnyPgColumn => designs.id,
      { onDelete: 'set null' },
    ),
    // The specific tag/baseline used as the derivation point
    sourceTagId: uuid('source_tag_id').references((): AnyPgColumn => tags.id, {
      onDelete: 'set null',
    }),
    // The specific commit used as the derivation point (if no tag specified)
    sourceCommitId: uuid('source_commit_id').references(
      (): AnyPgColumn => commits.id,
      {
        onDelete: 'set null',
      },
    ),

    // Planning info
    plannedQuantity: integer('planned_quantity'),

    // Default branch (usually main, set after creation)
    // Note: This is a forward reference - the branches table references designs.
    // NO ACTION (the references() default), deliberately not RESTRICT: during
    // DELETE FROM designs the cascade removes the design's own branches while
    // defaultBranchId still points at one — NO ACTION's end-of-statement check
    // passes (the design row is gone by then) where RESTRICT would abort
    // every design deletion.
    defaultBranchId: uuid('default_branch_id').references(
      (): AnyPgColumn => branches.id,
    ),

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
