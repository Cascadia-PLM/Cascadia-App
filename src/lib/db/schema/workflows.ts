import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
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

export const workflowInstances = pgTable('workflow_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowDefinitionId: uuid('workflow_definition_id').references(
    () => workflowDefinitions.id,
  ),
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
})

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
export const workflowStateApprovers = pgTable('workflow_state_approvers', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowDefinitionId: uuid('workflow_definition_id')
    .notNull()
    .references(() => workflowDefinitions.id, { onDelete: 'cascade' }),
  stateId: varchar('state_id', { length: 100 }).notNull(),
  approverType: varchar('approver_type', { length: 10 }).notNull(), // 'user' | 'role'
  approverId: uuid('approver_id').notNull(), // References users.id or roles.id
  isRequired: boolean('is_required').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdBy: uuid('created_by').references(() => users.id),
})

/**
 * Instance-level approval votes
 * Tracks actual approvals submitted by users for workflow instances
 */
export const workflowApprovalVotes = pgTable('workflow_approval_votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowInstanceId: uuid('workflow_instance_id')
    .notNull()
    .references(() => workflowInstances.id, { onDelete: 'cascade' }),
  stateId: varchar('state_id', { length: 100 }).notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  roleId: uuid('role_id'), // If approving on behalf of a role
  vote: varchar('vote', { length: 10 }).notNull(), // 'approved' | 'rejected'
  comments: text('comments'),
  votedAt: timestamp('voted_at', { withTimezone: true }).defaultNow().notNull(),
})

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
