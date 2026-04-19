import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'

// Program settings interface
// Note: Index signature uses JsonValue to be compatible with Drizzle ORM JSONB type inference
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | { [key: string]: JsonValue }
export interface ProgramSettings {
  approvalWorkflow?: Array<string> // ['Engineering', 'Manufacturing', 'Quality']
  ecoNumberFormat?: string // 'ECO-{YYYY}-{NNN}'
  [key: string]: JsonValue | undefined
}

export const programs = pgTable(
  'programs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Identity
    name: varchar('name', { length: 200 }).notNull(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    description: text('description'),

    // Program metadata
    contractNumber: varchar('contract_number', { length: 100 }),
    customer: varchar('customer', { length: 200 }),
    startDate: timestamp('start_date', { withTimezone: true }),
    targetEndDate: timestamp('target_end_date', { withTimezone: true }),

    // Status: 'Active', 'On Hold', 'Completed', 'Cancelled'
    status: varchar('status', { length: 50 }).notNull().default('Active'),

    // Settings
    settings: jsonb('settings').$type<ProgramSettings>().default({}),

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
    index('idx_program_status').on(table.status),
    index('idx_program_attributes').using('gin', table.attributes),
  ],
)

// Program membership (permission boundary)
export const programMembers = pgTable(
  'program_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Role within program: 'admin', 'lead', 'engineer', 'viewer'
    role: varchar('role', { length: 50 }).notNull().default('engineer'),

    // Permissions flags (for fine-grained control)
    canCreateEco: boolean('can_create_eco').default(true),
    canApproveEco: boolean('can_approve_eco').default(false),
    canManageProducts: boolean('can_manage_products').default(false),

    joinedAt: timestamp('joined_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    invitedBy: uuid('invited_by').references(() => users.id),
  },
  (table) => [
    unique('program_members_unique').on(table.programId, table.userId),
    index('idx_program_member_user').on(table.userId),
  ],
)

export const programsRelations = relations(programs, ({ one, many }) => ({
  members: many(programMembers),
  createdByUser: one(users, {
    fields: [programs.createdBy],
    references: [users.id],
    relationName: 'programCreator',
  }),
  updatedByUser: one(users, {
    fields: [programs.updatedBy],
    references: [users.id],
    relationName: 'programUpdater',
  }),
}))

export const programMembersRelations = relations(programMembers, ({ one }) => ({
  program: one(programs, {
    fields: [programMembers.programId],
    references: [programs.id],
  }),
  user: one(users, {
    fields: [programMembers.userId],
    references: [users.id],
  }),
  invitedByUser: one(users, {
    fields: [programMembers.invitedBy],
    references: [users.id],
    relationName: 'memberInviter',
  }),
}))
