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
import { users } from './users'
import { programs } from './programs'
import { items, workInstructions } from './items'

// =====================================================================
// Work Orders - standalone operational records (NOT a Cascadia item type)
// =====================================================================

export const workOrders = pgTable(
  'work_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workOrderNumber: varchar('work_order_number', { length: 20 })
      .notNull()
      .unique(),
    partId: uuid('part_id').references(() => items.id, {
      onDelete: 'set null',
    }),
    quantity: integer('quantity').notNull().default(1),
    status: varchar('status', { length: 20 }).notNull().default('Not Started'), // 'Not Started' | 'In Progress' | 'Complete' | 'Cancelled'
    priority: varchar('priority', { length: 10 }).notNull().default('Normal'), // 'Low' | 'Normal' | 'High' | 'Urgent'
    dueDate: timestamp('due_date', { withTimezone: true }),
    customerOrder: varchar('customer_order', { length: 200 }),
    notes: text('notes'),
    assignedTo: jsonb('assigned_to').$type<Array<string>>().default([]),
    programId: uuid('program_id').references(() => programs.id, {
      onDelete: 'set null',
    }),
    quantityCompleted: integer('quantity_completed').notNull().default(0),
    requiresSignOff: boolean('requires_sign_off').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index('idx_work_order_status').on(table.status),
    index('idx_work_order_part').on(table.partId),
    index('idx_work_order_due_date').on(table.dueDate),
    index('idx_work_order_program').on(table.programId),
    index('idx_work_order_customer').on(table.customerOrder),
  ],
)

export const workOrdersRelations = relations(workOrders, ({ one }) => ({
  part: one(items, {
    fields: [workOrders.partId],
    references: [items.id],
  }),
  program: one(programs, {
    fields: [workOrders.programId],
    references: [programs.id],
  }),
  creator: one(users, {
    fields: [workOrders.createdBy],
    references: [users.id],
    relationName: 'workOrderCreator',
  }),
  modifier: one(users, {
    fields: [workOrders.modifiedBy],
    references: [users.id],
    relationName: 'workOrderModifier',
  }),
}))

// =====================================================================
// Work Instruction Executions - execution tracking records
// =====================================================================

export const workInstructionExecutions = pgTable(
  'work_instruction_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workInstructionId: uuid('work_instruction_id')
      .notNull()
      .references(() => workInstructions.itemId, { onDelete: 'cascade' }),
    workInstructionRevision: varchar('work_instruction_revision', {
      length: 10,
    }),
    workOrderId: uuid('work_order_id').references(() => workOrders.id, {
      onDelete: 'set null',
    }),
    executedBy: uuid('executed_by')
      .notNull()
      .references(() => users.id),
    status: varchar('status', { length: 30 }).notNull().default('In Progress'), // 'In Progress' | 'Complete' | 'Incomplete' | 'Pending Approval' | 'Approved' | 'Rejected'
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    duration: integer('duration'), // in seconds
    stepData: jsonb('step_data')
      .$type<
        Record<
          string,
          {
            value: unknown
            capturedAt: string
            blockId: string
          }
        >
      >()
      .default({}),
    notes: text('notes'),
    currentStepIndex: integer('current_step_index').notNull().default(0),
  },
  (table) => [
    index('idx_wi_execution_wi').on(table.workInstructionId),
    index('idx_wi_execution_wo').on(table.workOrderId),
    index('idx_wi_execution_user').on(table.executedBy),
    index('idx_wi_execution_status').on(table.status),
    index('idx_wi_execution_started').on(table.startedAt),
  ],
)

export const workInstructionExecutionsRelations = relations(
  workInstructionExecutions,
  ({ one }) => ({
    workInstruction: one(workInstructions, {
      fields: [workInstructionExecutions.workInstructionId],
      references: [workInstructions.itemId],
    }),
    workOrder: one(workOrders, {
      fields: [workInstructionExecutions.workOrderId],
      references: [workOrders.id],
    }),
    executor: one(users, {
      fields: [workInstructionExecutions.executedBy],
      references: [users.id],
    }),
  }),
)

// =====================================================================
// Execution Sign-offs - supervisor review records
// =====================================================================

export const executionSignOffs = pgTable(
  'execution_sign_offs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => workInstructionExecutions.id, { onDelete: 'cascade' }),
    reviewerId: uuid('reviewer_id')
      .notNull()
      .references(() => users.id),
    decision: varchar('decision', { length: 20 }).notNull(), // 'approved' | 'rejected'
    comments: text('comments'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_sign_off_execution').on(table.executionId),
    index('idx_sign_off_reviewer').on(table.reviewerId),
  ],
)

export const executionSignOffsRelations = relations(
  executionSignOffs,
  ({ one }) => ({
    execution: one(workInstructionExecutions, {
      fields: [executionSignOffs.executionId],
      references: [workInstructionExecutions.id],
    }),
    reviewer: one(users, {
      fields: [executionSignOffs.reviewerId],
      references: [users.id],
    }),
  }),
)
