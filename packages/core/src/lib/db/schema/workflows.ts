// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { items } from './items'
import { users } from './users'

// ============================================
// Enums
// ============================================

/**
 * Lifecycle types for the unified lifecycle model:
 * - Free: Self-controlled with transitions (Programs, Projects, Designs)
 * - Driven: Controlled by ECOs, declares valid states only (Parts, Documents, Requirements)
 * - Driving: Controls Driven lifecycles, has TransitionDrivenItem actions (Change Orders)
 */
export const lifecycleTypeEnum = pgEnum('lifecycle_type', [
  'Free',
  'Driven',
  'Driving',
])

export const workflowDefinitions = pgTable('workflow_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull().unique(),
  version: integer('version').notNull(),
  workflowType: varchar('workflow_type', { length: 20 }).notNull(),
  definition: jsonb('definition').notNull(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),

  // Unified lifecycle model fields
  /** Free = self-controlled, Driven = ECO-controlled, Driving = ECO-type that controls others */
  lifecycleType: lifecycleTypeEnum('lifecycle_type').default('Free'),
  /** For Driven lifecycles: IDs of Driving lifecycles that can act on this lifecycle */
  drivers: jsonb('drivers').$type<Array<string>>().default([]),
})

export const workflowInstances = pgTable(
  'workflow_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK named in the table extras below — see the note there.
    workflowDefinitionId: uuid('workflow_definition_id'),
    itemId: uuid('item_id').references(() => items.id, { onDelete: 'cascade' }),
    currentState: varchar('current_state', { length: 100 }),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    context: jsonb('context'),

    // Instance-level workflow structure (for flexible workflows)
    // When null, use the definition. When populated, use these instead.
    instanceStates: jsonb('instance_states'), // Array<WorkflowState> | null
    instanceTransitions: jsonb('instance_transitions'), // Array<InstanceWorkflowTransition> | null

    // Scope lock fields (for Driving lifecycles like ECOs)
    // Once scope is locked, no more affected items can be added
    scopeLocked: boolean('scope_locked').default(false),
    scopeLockedAt: timestamp('scope_locked_at', { withTimezone: true }),

    // Release claim: set while a release/cancel is in flight so concurrent
    // transitions are blocked until the close completes or the claim goes stale
    releasingAt: timestamp('releasing_at', { withTimezone: true }),
  },
  (table) => [
    // Named explicitly: the implicit name is 68 bytes, past Postgres's 63.
    foreignKey({
      name: 'fk_wf_instances_definition',
      columns: [table.workflowDefinitionId],
      foreignColumns: [workflowDefinitions.id],
    }),
    // One active workflow per item — backs the check-then-insert in the routes
    uniqueIndex('workflow_instances_one_active_per_item')
      .on(table.itemId)
      .where(sql`${table.completedAt} IS NULL`),
  ],
)

export const workflowHistory = pgTable('workflow_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: uuid('instance_id')
    .notNull()
    .references(() => workflowInstances.id, { onDelete: 'cascade' }),
  fromState: varchar('from_state', { length: 100 }),
  toState: varchar('to_state', { length: 100 }),
  action: varchar('action', { length: 200 }),
  actorId: uuid('actor_id').references(() => users.id),
  timestamp: timestamp('timestamp', { withTimezone: true })
    .defaultNow()
    .notNull(),
  comments: text('comments'),
  data: jsonb('data'),
})

// Relations
export const workflowDefinitionsRelations = relations(
  workflowDefinitions,
  ({ many }) => ({
    instances: many(workflowInstances),
  }),
)

export const workflowInstancesRelations = relations(
  workflowInstances,
  ({ one, many }) => ({
    definition: one(workflowDefinitions, {
      fields: [workflowInstances.workflowDefinitionId],
      references: [workflowDefinitions.id],
    }),
    item: one(items, {
      fields: [workflowInstances.itemId],
      references: [items.id],
    }),
    history: many(workflowHistory),
  }),
)

export const workflowHistoryRelations = relations(
  workflowHistory,
  ({ one }) => ({
    instance: one(workflowInstances, {
      fields: [workflowHistory.instanceId],
      references: [workflowInstances.id],
    }),
    actor: one(users, {
      fields: [workflowHistory.actorId],
      references: [users.id],
    }),
  }),
)

// ============================================
// Approval Tables
// ============================================

/**
 * Definition-level approvers for workflow states
 * Defines which users or roles are required to approve at each state
 */
export const workflowStateApprovers = pgTable(
  'workflow_state_approvers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK named in the table extras below — see the note there.
    workflowDefinitionId: uuid('workflow_definition_id').notNull(),
    stateId: varchar('state_id', { length: 100 }).notNull(),
    approverType: varchar('approver_type', { length: 10 }).notNull(), // 'user' | 'role'
    approverId: uuid('approver_id').notNull(), // References users.id or roles.id
    isRequired: boolean('is_required').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (table) => [
    // Named explicitly: the implicit name is 74 bytes, past Postgres's 63.
    foreignKey({
      name: 'fk_wf_state_approvers_definition',
      columns: [table.workflowDefinitionId],
      foreignColumns: [workflowDefinitions.id],
    }).onDelete('cascade'),
    /**
     * One row per approver per state. `addStateApprover` selected for an
     * existing row and then inserted, which is the same TOCTOU window
     * `uq_wf_votes_active` closes one table over: two requests that both read
     * "not an approver yet" both wrote.
     *
     * A duplicate is not cosmetic. `getApprovalStatus` counts required
     * approvers to build the quorum and counts the approvals it has against
     * it, and the satisfaction loop collapses the twins while the counts do
     * not — so the state reports "1 of 2 approved" with one person named
     * twice, and stays there however many times that person approves.
     */
    unique('uq_wf_state_approvers').on(
      table.workflowDefinitionId,
      table.stateId,
      table.approverType,
      table.approverId,
    ),
  ],
)

/**
 * Instance-level approvers for workflow states (WI-4.2)
 *
 * The instance-scoped mirror of workflow_state_approvers: flexible
 * workflows copy their structure to the instance and let users add custom
 * states, which definition-keyed approvers can never cover. Gating reads
 * the union of definition-level and instance-level approvers.
 */
export const workflowInstanceApprovers = pgTable(
  'workflow_instance_approvers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK named in the table extras below — see the note there.
    workflowInstanceId: uuid('workflow_instance_id').notNull(),
    stateId: varchar('state_id', { length: 100 }).notNull(),
    approverType: varchar('approver_type', { length: 10 }).notNull(), // 'user' | 'role'
    approverId: uuid('approver_id').notNull(), // References users.id or roles.id
    isRequired: boolean('is_required').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (table) => [
    // Named explicitly: the implicit name is 73 bytes, past Postgres's 63.
    foreignKey({
      name: 'fk_wf_instance_approvers_instance',
      columns: [table.workflowInstanceId],
      foreignColumns: [workflowInstances.id],
    }).onDelete('cascade'),
    /**
     * The instance-scoped half of the same rule. Nothing here was
     * check-then-insert — `setInstanceApprovers` deletes the state's rows and
     * rewrites them — but the table feeds the identical count through
     * `getEffectiveApprovers`, so a duplicate arriving by any route (a
     * repeated pair inside one request's array, a structure copy replayed)
     * inflates the same quorum. The constraint is what makes that
     * unrepresentable rather than merely unlikely.
     */
    unique('uq_wf_instance_approvers').on(
      table.workflowInstanceId,
      table.stateId,
      table.approverType,
      table.approverId,
    ),
  ],
)

/**
 * Instance-level approval votes
 * Tracks actual approvals submitted by users for workflow instances
 */
export const workflowApprovalVotes = pgTable(
  'workflow_approval_votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK named in the table extras below — see the note there.
    workflowInstanceId: uuid('workflow_instance_id').notNull(),
    stateId: varchar('state_id', { length: 100 }).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleId: uuid('role_id'), // If approving on behalf of a role
    vote: varchar('vote', { length: 10 }).notNull(), // 'approved' | 'rejected'
    comments: text('comments'),
    votedAt: timestamp('voted_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Set when a backward (rework) transition invalidates this vote.
     * Votes are never deleted — an append-only audit trail has to show that a
     * vote existed and was superseded, not that it vanished (decision D7). Only
     * rows with supersededAt IS NULL count toward approval gating.
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (table) => [
    // Named explicitly: the implicit name is 69 bytes, past Postgres's 63.
    foreignKey({
      name: 'fk_wf_votes_instance',
      columns: [table.workflowInstanceId],
      foreignColumns: [workflowInstances.id],
    }).onDelete('cascade'),
    /**
     * One live vote per person per state. Partial on supersededAt IS NULL,
     * because that is exactly the set approval gating counts — a rework
     * supersedes the old vote and the same user must be able to vote again.
     *
     * The service checked for an existing vote before inserting, which is a
     * TOCTOU window: two requests that both read "no vote yet" both insert,
     * and getApprovalStatus then counts one person twice toward a quorum.
     */
    uniqueIndex('uq_wf_votes_active')
      .on(table.workflowInstanceId, table.stateId, table.userId)
      .where(sql`${table.supersededAt} IS NULL`),
    // Every read of this table is by instance and state.
    index('idx_wf_votes_instance_state').on(
      table.workflowInstanceId,
      table.stateId,
    ),
    /**
     * Gating counts `vote = 'approved'` rows, so a value outside this pair is
     * not a bad label — it is an approval that silently does not count.
     */
    check('ck_wf_votes_value', sql`${table.vote} IN ('approved', 'rejected')`),
  ],
)

// Approval table relations
export const workflowStateApproversRelations = relations(
  workflowStateApprovers,
  ({ one }) => ({
    workflowDefinition: one(workflowDefinitions, {
      fields: [workflowStateApprovers.workflowDefinitionId],
      references: [workflowDefinitions.id],
    }),
    createdByUser: one(users, {
      fields: [workflowStateApprovers.createdBy],
      references: [users.id],
    }),
  }),
)

export const workflowApprovalVotesRelations = relations(
  workflowApprovalVotes,
  ({ one }) => ({
    workflowInstance: one(workflowInstances, {
      fields: [workflowApprovalVotes.workflowInstanceId],
      references: [workflowInstances.id],
    }),
    user: one(users, {
      fields: [workflowApprovalVotes.userId],
      references: [users.id],
    }),
  }),
)

export const workflowInstanceApproversRelations = relations(
  workflowInstanceApprovers,
  ({ one }) => ({
    workflowInstance: one(workflowInstances, {
      fields: [workflowInstanceApprovers.workflowInstanceId],
      references: [workflowInstances.id],
    }),
    createdByUser: one(users, {
      fields: [workflowInstanceApprovers.createdBy],
      references: [users.id],
    }),
  }),
)
