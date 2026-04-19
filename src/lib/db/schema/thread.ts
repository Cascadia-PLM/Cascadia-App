import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { designs } from './designs'
import { items } from './items'
import { users } from './users'

/**
 * Represents a changed item in an upstream change notification.
 */
export interface UpstreamChangeItem {
  /** Master ID of the changed item */
  masterId: string
  /** Item number for display */
  itemNumber: string
  /** Item name for display */
  name: string | null
  /** Item type (Part, Document, etc.) */
  itemType: string
  /** Previous revision in source design */
  previousRevision: string
  /** New revision in source design */
  newRevision: string
  /** Type of change: 'modified' | 'added' | 'deleted' */
  changeType: 'modified' | 'added' | 'deleted'
  /** Fields that changed (for 'modified' items) */
  changedFields?: Array<string>
}

/**
 * Upstream change status values:
 * - 'pending': Change detected, not yet reviewed
 * - 'reviewed': Change reviewed but no action taken yet
 * - 'accepted': Change accepted, MBOM will be updated
 * - 'rejected': Change rejected, MBOM will not be updated
 * - 'deferred': Change deferred to future MCO
 */
export type UpstreamChangeStatus =
  | 'pending'
  | 'reviewed'
  | 'accepted'
  | 'rejected'
  | 'deferred'

/**
 * Tracks when source EBOM changes affect derived MBOMs.
 * Created when an ECO is released on an Engineering design that has derived MBOMs.
 * Manufacturing team reviews these to decide whether to update their MBOM.
 */
export const upstreamChanges = pgTable(
  'upstream_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Target MBOM design that may need updates
    targetDesignId: uuid('target_design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),

    // Source Engineering design where change originated
    sourceDesignId: uuid('source_design_id')
      .notNull()
      .references(() => designs.id, { onDelete: 'cascade' }),

    // The commit on the source design that introduced the change
    sourceCommitId: uuid('source_commit_id'),

    // The ECO that was released (if applicable)
    sourceEcoId: uuid('source_eco_id').references(() => items.id, {
      onDelete: 'set null',
    }),

    // List of items that changed in the source design
    changedItems: jsonb('changed_items')
      .$type<Array<UpstreamChangeItem>>()
      .notNull(),

    // Review status: 'pending' | 'reviewed' | 'accepted' | 'rejected' | 'deferred'
    status: varchar('status', { length: 50 }).notNull().default('pending'),

    // Review tracking
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNotes: text('review_notes'),

    // If accepted, the MCO created to update the MBOM
    responseEcoId: uuid('response_eco_id').references(() => items.id, {
      onDelete: 'set null',
    }),

    // Audit
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_upstream_changes_target').on(table.targetDesignId),
    index('idx_upstream_changes_source').on(table.sourceDesignId),
    index('idx_upstream_changes_status').on(table.status),
    index('idx_upstream_changes_source_eco').on(table.sourceEcoId),
  ],
)

export const upstreamChangesRelations = relations(
  upstreamChanges,
  ({ one }) => ({
    targetDesign: one(designs, {
      fields: [upstreamChanges.targetDesignId],
      references: [designs.id],
      relationName: 'upstreamChangesTarget',
    }),
    sourceDesign: one(designs, {
      fields: [upstreamChanges.sourceDesignId],
      references: [designs.id],
      relationName: 'upstreamChangesSource',
    }),
    sourceEco: one(items, {
      fields: [upstreamChanges.sourceEcoId],
      references: [items.id],
      relationName: 'upstreamChangeSourceEco',
    }),
    responseEco: one(items, {
      fields: [upstreamChanges.responseEcoId],
      references: [items.id],
      relationName: 'upstreamChangeResponseEco',
    }),
    reviewer: one(users, {
      fields: [upstreamChanges.reviewedBy],
      references: [users.id],
    }),
  }),
)
