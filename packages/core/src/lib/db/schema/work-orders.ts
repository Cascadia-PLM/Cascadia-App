// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { users } from './users'
import { programs } from './programs'
import { items, workInstructions } from './items'
import type { StepContent } from './items'

// =====================================================================
// Work Orders — item type table (two-table pattern, Tool pattern:
// non-versioned, no designId, Free lifecycle).
//
// Identity fields ride the items row: itemNumber (WO-######), state
// ('Not Started' | 'In Progress' | 'Complete' | 'Cancelled'), created/
// modified audit. This table holds the manufacturing-specific fields.
// Promoted from a standalone table so WOs get vault attachments and
// digital-thread membership — docs/features/physical-parts-and-traceability.md §4.5.
// =====================================================================

export const workOrders = pgTable(
  'work_orders',
  {
    itemId: uuid('item_id')
      .primaryKey()
      .references(() => items.id, { onDelete: 'cascade' }),
    // The part version this WO builds (pins the exact revision).
    partId: uuid('part_id').references(() => items.id, {
      onDelete: 'set null',
    }),
    quantity: integer('quantity').notNull().default(1),
    quantityCompleted: integer('quantity_completed').notNull().default(0),
    priority: varchar('priority', { length: 10 }).notNull().default('Normal'), // 'Low' | 'Normal' | 'High' | 'Urgent'
    dueDate: timestamp('due_date', { withTimezone: true }),
    customerOrder: varchar('customer_order', { length: 200 }),
    assignedTo: jsonb('assigned_to').$type<Array<string>>().default([]),
    // Items scope to programs via designId; WOs have no design, so the
    // program boundary stays explicit here.
    programId: uuid('program_id').references(() => programs.id, {
      onDelete: 'set null',
    }),
    requiresSignOff: boolean('requires_sign_off').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (table) => [
    index('idx_work_order_part').on(table.partId),
    index('idx_work_order_due_date').on(table.dueDate),
    index('idx_work_order_program').on(table.programId),
    index('idx_work_order_customer').on(table.customerOrder),
  ],
)

export const workOrdersRelations = relations(workOrders, ({ one }) => ({
  item: one(items, {
    fields: [workOrders.itemId],
    references: [items.id],
  }),
  part: one(items, {
    fields: [workOrders.partId],
    references: [items.id],
    relationName: 'workOrderPart',
  }),
  program: one(programs, {
    fields: [workOrders.programId],
    references: [programs.id],
  }),
}))

// =====================================================================
// Work Order Instructions — traveler lines.
//
// An instance of a WorkInstruction template inside a work order. The
// template's content (metadata + operations + steps) is snapshotted into
// `snapshot` at instantiation, so the traveler on the floor never mutates
// when the template is edited or deleted; `workInstructionId` is
// provenance only. Line status is DERIVED from executions (countable runs
// ≥ requiredCount), never stored — same "quantity is a query" principle
// as material traceability.
// =====================================================================

/** Frozen copy of a WorkInstruction template taken at instantiation. */
export interface InstructionSnapshot {
  name: string
  description: string | null
  estimatedTime: number | null // minutes
  difficulty: string | null
  safetyNotes: string | null
  requiredTools: string | null
  operations: Array<{
    id: string
    orderIndex: number
    title: string
    description: string | null
    estimatedTime: number | null
  }>
  steps: Array<{
    id: string
    operationId: string | null
    orderIndex: number
    title: string | null
    content: StepContent
  }>
}

export const workOrderInstructions = pgTable(
  'work_order_instructions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workOrderId: uuid('work_order_id')
      .notNull()
      .references(() => workOrders.itemId, { onDelete: 'cascade' }),
    // Provenance: the template this line was instantiated from. The
    // snapshot keeps the line executable if the template is deleted.
    workInstructionId: uuid('work_instruction_id').references(
      () => workInstructions.itemId,
      { onDelete: 'set null' },
    ),
    // The part this line applies to — the order's built part, or a BOM
    // descendant when the order fabricates subassemblies too.
    partId: uuid('part_id').references(() => items.id, {
      onDelete: 'set null',
    }),
    orderIndex: integer('order_index').notNull().default(0),
    // Snapshot identity (survives template deletion/renames).
    title: varchar('title', { length: 500 }).notNull(),
    instructionNumber: varchar('instruction_number', { length: 64 }),
    instructionRevision: varchar('instruction_revision', { length: 10 }),
    snapshot: jsonb('snapshot').$type<InstructionSnapshot>().notNull(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Completed runs needed for this line to count as done: 1 for a batch
    // step, the order quantity for per-unit steps.
    requiredCount: integer('required_count').notNull().default(1),
    // Audited not-applicable marker — the escape hatch from the work
    // order completion gate.
    skippedAt: timestamp('skipped_at', { withTimezone: true }),
    skippedBy: uuid('skipped_by').references(() => users.id),
    skipReason: text('skip_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index('idx_wo_instruction_order').on(table.workOrderId, table.orderIndex),
    index('idx_wo_instruction_template').on(table.workInstructionId),
    index('idx_wo_instruction_part').on(table.partId),
  ],
)

export const workOrderInstructionsRelations = relations(
  workOrderInstructions,
  ({ one, many }) => ({
    workOrder: one(workOrders, {
      fields: [workOrderInstructions.workOrderId],
      references: [workOrders.itemId],
    }),
    workInstruction: one(workInstructions, {
      fields: [workOrderInstructions.workInstructionId],
      references: [workInstructions.itemId],
    }),
    part: one(items, {
      fields: [workOrderInstructions.partId],
      references: [items.id],
    }),
    executions: many(instructionExecutions),
  }),
)

// =====================================================================
// Instruction Executions — a technician's run of one traveler line.
// =====================================================================

export const instructionExecutions = pgTable(
  'instruction_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workOrderInstructionId: uuid('work_order_instruction_id')
      .notNull()
      .references(() => workOrderInstructions.id, { onDelete: 'cascade' }),
    executedBy: uuid('executed_by')
      .notNull()
      .references(() => users.id),
    // Optional tag for which unit/serial this run covered (free text until
    // executions link to produced PhysicalParts).
    unitLabel: varchar('unit_label', { length: 200 }),
    status: varchar('status', { length: 30 }).notNull().default('In Progress'), // 'In Progress' | 'Complete' | 'Incomplete' | 'Pending Approval' | 'Approved' | 'Rejected'
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    duration: integer('duration'), // in seconds
    // Captured values keyed by snapshot block id.
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
    /**
     * One open run per technician per line per unit. Partial on the
     * 'In Progress' status, because that is exactly the set a resume looks in
     * — a completed run must not stop the same person opening the next one.
     *
     * `start()` checked for an open run and then inserted, which is a TOCTOU
     * window: two requests that both read "no open run" both insert, and the
     * traveler's countable tally
     * (`WorkOrderInstructionService.deriveStatus`, `completedCount >=
     * line.requiredCount`) then counts one physical run twice — toward the
     * gate that says a work order may be completed. Same shape, and the same
     * fix, as `uq_wf_votes_active` on the approval votes.
     *
     * COALESCE because SQL treats two NULL unit labels as distinct while the
     * traveler does not. It is safe: `start()` stores `unitLabel || null`, so
     * the empty string is never persisted and cannot collide with a real one.
     */
    uniqueIndex('uq_instr_exec_open_run')
      .on(
        table.workOrderInstructionId,
        table.executedBy,
        sql`COALESCE(${table.unitLabel}, '')`,
      )
      .where(sql`${table.status} = 'In Progress'`),
    index('idx_instr_execution_line').on(table.workOrderInstructionId),
    index('idx_instr_execution_user').on(table.executedBy),
    index('idx_instr_execution_status').on(table.status),
    index('idx_instr_execution_started').on(table.startedAt),
    /**
     * The six literals the column comment enumerates. The countable tally
     * counts `status IN ('Complete','Approved')`, so a value outside this set
     * is not a bad label — it is a run that silently does not count toward the
     * work order's completion gate.
     */
    check(
      'ck_instr_exec_status',
      sql`${table.status} IN ('In Progress', 'Complete', 'Incomplete', 'Pending Approval', 'Approved', 'Rejected')`,
    ),
  ],
)

export const instructionExecutionsRelations = relations(
  instructionExecutions,
  ({ one }) => ({
    workOrderInstruction: one(workOrderInstructions, {
      fields: [instructionExecutions.workOrderInstructionId],
      references: [workOrderInstructions.id],
    }),
    executor: one(users, {
      fields: [instructionExecutions.executedBy],
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
      .references(() => instructionExecutions.id, { onDelete: 'cascade' }),
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
    execution: one(instructionExecutions, {
      fields: [executionSignOffs.executionId],
      references: [instructionExecutions.id],
    }),
    reviewer: one(users, {
      fields: [executionSignOffs.reviewerId],
      references: [users.id],
    }),
  }),
)
