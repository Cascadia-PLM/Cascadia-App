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

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    itemType: varchar('item_type', { length: 50 }).notNull(),
    isPublic: boolean('is_public').default(false).notNull(),
    sharedWithRoles: jsonb('shared_with_roles').$type<Array<string>>(),
    sharedWithUsers: jsonb('shared_with_users').$type<Array<string>>(),
    config: jsonb('config').$type<Record<string, unknown>>(),
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
    index('idx_reports_item_type').on(table.itemType),
    index('idx_reports_created_by').on(table.createdBy),
    index('idx_reports_is_public').on(table.isPublic),
  ],
)

export const reportColumns = pgTable(
  'report_columns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    fieldPath: varchar('field_path', { length: 255 }).notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    displayOrder: integer('display_order').notNull().default(0),
    formatType: varchar('format_type', { length: 50 }),
    isVisible: boolean('is_visible').default(true).notNull(),
    width: integer('width'),
  },
  (table) => [index('idx_report_columns_report').on(table.reportId)],
)

export const reportFilters = pgTable(
  'report_filters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    fieldPath: varchar('field_path', { length: 255 }).notNull(),
    operator: varchar('operator', { length: 50 }).notNull(),
    value: text('value'),
    value2: text('value2'), // For 'between' operator
    displayOrder: integer('display_order').notNull().default(0),
  },
  (table) => [index('idx_report_filters_report').on(table.reportId)],
)

export const reportSorts = pgTable(
  'report_sorts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    fieldPath: varchar('field_path', { length: 255 }).notNull(),
    direction: varchar('direction', { length: 10 }).notNull().default('asc'),
    priority: integer('priority').notNull().default(0),
  },
  (table) => [index('idx_report_sorts_report').on(table.reportId)],
)

export const reportExecutions = pgTable(
  'report_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    executedBy: uuid('executed_by')
      .notNull()
      .references(() => users.id),
    executedAt: timestamp('executed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    rowCount: integer('row_count'),
    durationMs: integer('duration_ms'),
    parameters: jsonb('parameters').$type<Record<string, unknown>>(),
    success: boolean('success').default(true).notNull(),
    errorMessage: text('error_message'),
  },
  (table) => [
    index('idx_report_executions_report').on(table.reportId),
    index('idx_report_executions_executed_by').on(table.executedBy),
    index('idx_report_executions_executed_at').on(table.executedAt),
  ],
)

export const reportExports = pgTable(
  'report_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').references(() => reportExecutions.id, {
      onDelete: 'set null',
    }),
    exportedBy: uuid('exported_by')
      .notNull()
      .references(() => users.id),
    exportedAt: timestamp('exported_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    format: varchar('format', { length: 20 }).notNull().default('csv'),
    fileName: varchar('file_name', { length: 255 }),
    fileSize: integer('file_size'),
    storagePath: text('storage_path'),
  },
  (table) => [
    index('idx_report_exports_report').on(table.reportId),
    index('idx_report_exports_exported_by').on(table.exportedBy),
  ],
)

// Relations
export const reportsRelations = relations(reports, ({ one, many }) => ({
  creator: one(users, {
    fields: [reports.createdBy],
    references: [users.id],
    relationName: 'reportCreator',
  }),
  modifier: one(users, {
    fields: [reports.modifiedBy],
    references: [users.id],
    relationName: 'reportModifier',
  }),
  columns: many(reportColumns),
  filters: many(reportFilters),
  sorts: many(reportSorts),
  executions: many(reportExecutions),
  exports: many(reportExports),
}))

export const reportColumnsRelations = relations(reportColumns, ({ one }) => ({
  report: one(reports, {
    fields: [reportColumns.reportId],
    references: [reports.id],
  }),
}))

export const reportFiltersRelations = relations(reportFilters, ({ one }) => ({
  report: one(reports, {
    fields: [reportFilters.reportId],
    references: [reports.id],
  }),
}))

export const reportSortsRelations = relations(reportSorts, ({ one }) => ({
  report: one(reports, {
    fields: [reportSorts.reportId],
    references: [reports.id],
  }),
}))

export const reportExecutionsRelations = relations(
  reportExecutions,
  ({ one }) => ({
    report: one(reports, {
      fields: [reportExecutions.reportId],
      references: [reports.id],
    }),
    executor: one(users, {
      fields: [reportExecutions.executedBy],
      references: [users.id],
    }),
  }),
)

export const reportExportsRelations = relations(reportExports, ({ one }) => ({
  report: one(reports, {
    fields: [reportExports.reportId],
    references: [reports.id],
  }),
  execution: one(reportExecutions, {
    fields: [reportExports.executionId],
    references: [reportExecutions.id],
  }),
  exporter: one(users, {
    fields: [reportExports.exportedBy],
    references: [users.id],
  }),
}))
