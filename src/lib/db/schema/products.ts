import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { programs } from './programs'
import { users } from './users'

export const products = pgTable(
  'products',
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

    // Product type: 'product' for normal products, 'library' for Standard Library
    productType: varchar('product_type', { length: 50 })
      .notNull()
      .default('product'),

    // Planning info
    plannedQuantity: integer('planned_quantity'),

    // Default branch (usually main, set after creation)
    // Note: This is a forward reference - the branches table references products
    defaultBranchId: uuid('default_branch_id'),

    // Status
    isArchived: boolean('is_archived').default(false),

    // SysML API compatibility
    sysmlProjectId: uuid('sysml_project_id'), // For external tool sync

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
  },
  (table) => [
    index('idx_product_program').on(table.programId),
    index('idx_product_type').on(table.productType),
  ],
)

export const productsRelations = relations(products, ({ one }) => ({
  program: one(programs, {
    fields: [products.programId],
    references: [programs.id],
  }),
  createdByUser: one(users, {
    fields: [products.createdBy],
    references: [users.id],
  }),
  // Note: branches, items, and defaultBranch relations are defined in versioning.ts
  // to avoid circular dependency issues
}))
