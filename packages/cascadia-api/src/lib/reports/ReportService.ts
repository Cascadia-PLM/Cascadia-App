// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notIlike,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '../db'
import { takeFirst } from '../db/take-first'
import { likeContains, likeEndsWith, likeStartsWith } from '../db/like-pattern'
import { accessScopeCondition } from '../db/filters'
import { AccessControlService } from '../auth/AccessControlService'
import { permissionService } from '../auth/permission-service'
import { NotFoundError, PermissionDeniedError } from '../errors'
import {
  changeOrders,
  documents,
  issues,
  items,
  parts,
  reportColumns,
  reportExecutions,
  reportExports,
  reportFilters,
  reportSorts,
  reports,
  requirements,
  tasks,
  testCases,
  testPlans,
} from '../db/schema'
import { paginatedOrderBy } from '../db/paginated-order'
import type { AccessScope } from '../db/filters'
import type { SQL } from 'drizzle-orm'
import type {
  FilterOperator,
  Report,
  ReportColumn,
  ReportCreateInput,
  ReportExecutionOptions,
  ReportExecutionResult,
  ReportFilter,
  ReportSort,
} from './types'

// Type-specific table mapping
const typeTableMap = {
  Part: parts,
  Document: documents,
  ChangeOrder: changeOrders,
  Requirement: requirements,
  Task: tasks,
  TestPlan: testPlans,
  TestCase: testCases,
  Issue: issues,
} as const

type ItemType = keyof typeof typeTableMap

/**
 * Service layer for report operations
 * Provides CRUD operations, execution engine, and export functionality
 */
export class ReportService {
  /**
   * Create a new report with columns, filters, and sorts
   */
  static async create(
    data: ReportCreateInput,
    userId: string,
  ): Promise<Report> {
    return db.transaction(async (tx) => {
      // Insert main report
      const report = takeFirst(
        await tx
          .insert(reports)
          .values({
            name: data.name,
            description: data.description,
            itemType: data.itemType,
            isPublic: data.isPublic,
            sharedWithRoles: data.sharedWithRoles,
            sharedWithUsers: data.sharedWithUsers,
            config: data.config,
            createdBy: userId,
            modifiedBy: userId,
          })
          .returning(),
      )

      // Insert columns (columns is required and must have at least one)
      await tx.insert(reportColumns).values(
        data.columns.map((col) => ({
          reportId: report.id,
          fieldPath: col.fieldPath,
          label: col.label,
          displayOrder: col.displayOrder,
          formatType: col.formatType,
          isVisible: col.isVisible,
          width: col.width,
        })),
      )

      // Insert filters (optional array, defaults to [])
      if (data.filters.length > 0) {
        await tx.insert(reportFilters).values(
          data.filters.map((filter) => ({
            reportId: report.id,
            fieldPath: filter.fieldPath,
            operator: filter.operator,
            value: filter.value,
            value2: filter.value2,
            displayOrder: filter.displayOrder,
          })),
        )
      }

      // Insert sorts (optional array, defaults to [])
      if (data.sorts.length > 0) {
        await tx.insert(reportSorts).values(
          data.sorts.map((sort) => ({
            reportId: report.id,
            fieldPath: sort.fieldPath,
            direction: sort.direction,
            priority: sort.priority,
          })),
        )
      }

      return this.enrichReport(report, tx)
    })
  }

  /**
   * Update an existing report
   */
  static async update(
    reportId: string,
    data: Partial<ReportCreateInput>,
    userId: string,
  ): Promise<Report> {
    return db.transaction(async (tx) => {
      // Update main report
      const updateData: Record<string, unknown> = {
        modifiedBy: userId,
        modifiedAt: new Date(),
      }

      if (data.name !== undefined) updateData.name = data.name
      if (data.description !== undefined)
        updateData.description = data.description
      if (data.itemType !== undefined) updateData.itemType = data.itemType
      if (data.isPublic !== undefined) updateData.isPublic = data.isPublic
      if (data.sharedWithRoles !== undefined)
        updateData.sharedWithRoles = data.sharedWithRoles
      if (data.sharedWithUsers !== undefined)
        updateData.sharedWithUsers = data.sharedWithUsers
      if (data.config !== undefined) updateData.config = data.config

      await tx.update(reports).set(updateData).where(eq(reports.id, reportId))

      // Each child collection is replaced wholesale — but only when the caller
      // actually sent that key.
      //
      // `undefined` means "not supplied, leave it alone"; `[]` means "supplied
      // and empty", which legitimately clears filters and sorts. The delete
      // used to run unconditionally, so a `PUT` carrying just a name — which
      // `reportSchema.partial()` accepts, and which the edit form sends —
      // stripped every column off the report, leaving it in a state its own
      // schema forbids (`columns` is `min(1)`) and returning rows with no
      // columns. `.partial()` wraps `ZodOptional` *outside* the `ZodDefault` on
      // filters and sorts, so an absent key stays `undefined` rather than
      // falling back to `[]`; the defaults never rescued this.
      if (data.columns !== undefined) {
        await tx
          .delete(reportColumns)
          .where(eq(reportColumns.reportId, reportId))
        if (data.columns.length > 0) {
          await tx.insert(reportColumns).values(
            data.columns.map((col) => ({
              reportId,
              fieldPath: col.fieldPath,
              label: col.label,
              displayOrder: col.displayOrder,
              formatType: col.formatType,
              isVisible: col.isVisible,
              width: col.width,
            })),
          )
        }
      }

      if (data.filters !== undefined) {
        await tx
          .delete(reportFilters)
          .where(eq(reportFilters.reportId, reportId))
        if (data.filters.length > 0) {
          await tx.insert(reportFilters).values(
            data.filters.map((filter) => ({
              reportId,
              fieldPath: filter.fieldPath,
              operator: filter.operator,
              value: filter.value,
              value2: filter.value2,
              displayOrder: filter.displayOrder,
            })),
          )
        }
      }

      if (data.sorts !== undefined) {
        await tx.delete(reportSorts).where(eq(reportSorts.reportId, reportId))
        if (data.sorts.length > 0) {
          await tx.insert(reportSorts).values(
            data.sorts.map((sort) => ({
              reportId,
              fieldPath: sort.fieldPath,
              direction: sort.direction,
              priority: sort.priority,
            })),
          )
        }
      }

      const results = await tx
        .select()
        .from(reports)
        .where(eq(reports.id, reportId))
        .limit(1)
      const updated = results[0]
      if (!updated) {
        throw new Error('Report not found after update')
      }

      return this.enrichReport(updated, tx)
    })
  }

  /**
   * Delete a report (cascade handles children)
   */
  static async delete(reportId: string): Promise<void> {
    await db.delete(reports).where(eq(reports.id, reportId))
  }

  /**
   * Find a report by ID with enriched children.
   *
   * Existence only — this does not ask whether the caller may see it. Every
   * request path should be going through `findByIdForUser` or `requireWritable`
   * instead; this stays for the two of them to build on.
   */
  static async findById(reportId: string): Promise<Report | null> {
    const result = await db
      .select()
      .from(reports)
      .where(eq(reports.id, reportId))
      .limit(1)
    const report = result[0]
    if (!report) {
      return null
    }
    return this.enrichReport(report)
  }

  /**
   * Build access conditions for report queries
   */
  private static buildAccessConditions(
    userId: string,
    userRoles: Array<string> = [],
  ): Array<SQL> {
    const accessConditions: Array<SQL> = [
      eq(reports.createdBy, userId),
      eq(reports.isPublic, true),
    ]

    if (userRoles.length > 0) {
      accessConditions.push(
        sql`${reports.sharedWithRoles}::jsonb ?| array[${sql.join(
          userRoles.map((r) => sql`${r}`),
          sql`, `,
        )}]`,
      )
    }

    accessConditions.push(sql`${reports.sharedWithUsers}::jsonb ? ${userId}`)

    return accessConditions
  }

  /**
   * The "may this caller open this report" predicate, with the caller's roles
   * resolved rather than taken on trust.
   *
   * The roles used to be a parameter, and every route passed `[]` — which
   * silently disabled the `sharedWithRoles` arm of the rule, so sharing a
   * report with a role shared it with nobody. A parameter every caller gets
   * wrong is the wrong shape, so it is derived here instead.
   */
  private static async accessConditionFor(userId: string): Promise<SQL> {
    const userRoles = await permissionService.getUserRoles(userId)
    return or(...this.buildAccessConditions(userId, userRoles)) as SQL
  }

  /**
   * Find a report the caller is allowed to open.
   *
   * Returns `null` both when the report does not exist and when it exists but
   * was never shared with the caller. The two are deliberately
   * indistinguishable: a 404 either way means walking IDs cannot enumerate
   * other people's reports.
   */
  static async findByIdForUser(
    reportId: string,
    userId: string,
  ): Promise<Report | null> {
    const result = await db
      .select()
      .from(reports)
      .where(
        and(eq(reports.id, reportId), await this.accessConditionFor(userId)),
      )
      .limit(1)

    const report = result[0]
    if (!report) {
      return null
    }
    return this.enrichReport(report)
  }

  /**
   * Resolve a report the caller is allowed to *change*, or throw.
   *
   * Being shown a report is not being handed the pen: sharing distributes the
   * query, not the right to rewrite or destroy it. Only the creator may do
   * that — plus `system:manage`, so an instance administrator can still clean
   * up after somebody who has left.
   *
   * That admin arm reads through `findById` rather than the sharing rule,
   * which is why an administrator can delete a private report they could not
   * have opened. Deliberate: the alternative is a report nobody can remove
   * once its author is gone.
   */
  static async requireWritable(
    reportId: string,
    userId: string,
    action: 'update' | 'delete',
  ): Promise<Report> {
    const isAdmin = await permissionService.canUser(userId, 'manage', 'system')

    const report = isAdmin
      ? await this.findById(reportId)
      : await this.findByIdForUser(reportId, userId)

    if (!report) {
      throw new NotFoundError('Report', reportId)
    }
    if (isAdmin || report.createdBy === userId) {
      return report
    }
    throw new PermissionDeniedError('report', action)
  }

  /**
   * List reports accessible to the user with server-side pagination
   */
  static async list(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ reports: Array<Report>; total: number }> {
    const whereClause = await this.accessConditionFor(userId)

    const { count: total } = takeFirst(
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(reports)
        .where(whereClause),
      'report count',
    )

    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const result = await db
      .select()
      .from(reports)
      .where(whereClause)
      .orderBy(...paginatedOrderBy(desc(reports.modifiedAt), reports.id))
      .limit(limit)
      .offset(offset)

    const enriched = await Promise.all(result.map((r) => this.enrichReport(r)))
    return { reports: enriched, total }
  }

  /**
   * List reports by item type with server-side pagination
   */
  static async listByItemType(
    itemType: string,
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ reports: Array<Report>; total: number }> {
    const whereClause = and(
      await this.accessConditionFor(userId),
      eq(reports.itemType, itemType),
    )

    const { count: total } = takeFirst(
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(reports)
        .where(whereClause),
      'report count',
    )

    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const result = await db
      .select()
      .from(reports)
      .where(whereClause)
      .orderBy(...paginatedOrderBy(desc(reports.modifiedAt), reports.id))
      .limit(limit)
      .offset(offset)

    const enriched = await Promise.all(result.map((r) => this.enrichReport(r)))
    return { reports: enriched, total }
  }

  /**
   * Execute a report and return results
   */
  static async execute(
    reportId: string,
    options: ReportExecutionOptions = {},
    userId: string,
  ): Promise<ReportExecutionResult> {
    const startTime = Date.now()

    // A report the caller may not open is a report they may not run. Same
    // 404-either-way rule as `findByIdForUser`, so an unshared report cannot
    // be confirmed to exist by executing it.
    const report = await this.findByIdForUser(reportId, userId)
    if (!report) {
      throw new NotFoundError('Report', reportId)
    }

    try {
      // Report *definition* access (created-by / shared-with, see
      // `buildAccessConditions`) says who may open the saved query. It says
      // nothing about which rows that query is allowed to return, so the
      // caller's own design reach has to bound the result set as well — the
      // same bound the item list and search apply.
      //
      // Resolved here rather than passed in: `execute` is the only way to run
      // a report, and both the execute and export routes go through it, so
      // deriving the scope from `userId` at this one point means no caller can
      // forget to pass it.
      const callerScope = await AccessControlService.getAccessScope(userId)

      const result = await this.buildAndExecuteQuery(
        report,
        options,
        callerScope,
      )
      const durationMs = Date.now() - startTime

      // Log execution
      const execution = takeFirst(
        await db
          .insert(reportExecutions)
          .values({
            reportId,
            executedBy: userId,
            rowCount: result.totalRows,
            durationMs,
            parameters: options as Record<string, unknown>,
            success: true,
          })
          .returning(),
      )

      return {
        ...result,
        reportId,
        reportName: report.name,
        executedAt: new Date(),
        durationMs,
        executionId: execution.id,
      }
    } catch (error) {
      const durationMs = Date.now() - startTime

      // Log failed execution
      await db.insert(reportExecutions).values({
        reportId,
        executedBy: userId,
        durationMs,
        parameters: options as Record<string, unknown>,
        success: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      })

      throw error
    }
  }

  /**
   * Build and execute the query for a report
   */
  private static async buildAndExecuteQuery(
    report: Report,
    options: ReportExecutionOptions,
    callerScope: AccessScope | null,
  ): Promise<
    Omit<
      ReportExecutionResult,
      'reportId' | 'reportName' | 'executedAt' | 'durationMs'
    >
  > {
    const limit = options.limit ?? 100
    const offset = options.offset ?? 0

    const itemType = report.itemType as ItemType
    if (!(itemType in typeTableMap)) {
      throw new Error(`Unknown item type: ${report.itemType}`)
    }
    const typeTable = typeTableMap[itemType]

    // Build filter conditions
    const allFilters = [
      ...(report.filters || []),
      ...(options.runtimeFilters || []),
    ]
    const conditions: Array<SQL> = [eq(items.itemType, report.itemType)]

    // Ahead of the report's own filters, and ANDed with them, so no saved
    // filter can widen the result past what the caller may read. Bounds the
    // count as much as the rows: a total of "142 parts" discloses the size of
    // a program the caller cannot open.
    const accessScope = accessScopeCondition(callerScope)
    if (accessScope) conditions.push(accessScope)

    for (const filter of allFilters) {
      const condition = this.buildFilterCondition(filter, itemType, typeTable)
      if (condition) {
        conditions.push(condition)
      }
    }

    // Build sort order
    const sortOrder: Array<SQL> = []
    const sortedSorts = [...(report.sorts || [])].sort(
      (a, b) => a.priority - b.priority,
    )

    for (const sort of sortedSorts) {
      const field = this.getFieldFromPath(sort.fieldPath, itemType, typeTable)
      if (field) {
        sortOrder.push(sort.direction === 'desc' ? desc(field) : asc(field))
      }
    }

    // Default sort if none specified
    if (sortOrder.length === 0) {
      sortOrder.push(desc(items.modifiedAt))
    }

    // Count total matching rows
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(items)
      .leftJoin(typeTable, eq(items.id, typeTable.itemId))
      .where(and(...conditions))

    const totalRows = countResult?.count ?? 0

    // Execute query
    const queryResult = await db
      .select()
      .from(items)
      .leftJoin(typeTable, eq(items.id, typeTable.itemId))
      .where(and(...conditions))
      .orderBy(...paginatedOrderBy(sortOrder, items.id))
      .limit(limit + 1) // Fetch one extra to check for more
      .offset(offset)

    const hasMore = queryResult.length > limit
    const rows = queryResult.slice(0, limit)

    // Transform results to flat objects with requested columns
    const columns = report.columns || []
    const transformedRows = rows.map((row) => {
      const result: Record<string, unknown> = {}
      for (const col of columns) {
        result[col.fieldPath] = this.getValueFromPath(
          col.fieldPath,
          row,
          itemType,
        )
      }
      return result
    })

    return {
      totalRows,
      columns,
      rows: transformedRows,
      pagination: {
        limit,
        offset,
        hasMore,
      },
    }
  }

  /**
   * Build a filter condition from a ReportFilter
   */
  private static buildFilterCondition(
    filter:
      | ReportFilter
      | {
          fieldPath: string
          operator: FilterOperator
          value?: string
          value2?: string
        },
    itemType: ItemType,
    typeTable:
      | typeof parts
      | typeof documents
      | typeof changeOrders
      | typeof requirements
      | typeof tasks
      | typeof testPlans
      | typeof testCases
      | typeof issues,
  ): SQL | null {
    const field = this.getFieldFromPath(filter.fieldPath, itemType, typeTable)
    if (!field) {
      return null
    }

    const value = filter.value
    const value2 = filter.value2

    switch (filter.operator) {
      case 'eq':
        return eq(field, value)
      case 'ne':
        return ne(field, value)
      case 'gt':
        return gt(field, value)
      case 'lt':
        return lt(field, value)
      case 'gte':
        return gte(field, value)
      case 'lte':
        return lte(field, value)
      // The text operators are match MODES over a literal value, not a
      // pattern language: `%` and `_` in a saved filter mean themselves.
      case 'like':
        if (value == null) return null
        return ilike(field, likeContains(value))
      case 'not_like':
        if (value == null) return null
        return notIlike(field, likeContains(value))
      case 'in':
        if (value) {
          const values = value.split(',').map((v) => v.trim())
          return inArray(field, values)
        }
        return null
      case 'not_in':
        if (value) {
          const values = value.split(',').map((v) => v.trim())
          return notInArray(field, values)
        }
        return null
      case 'is_null':
        return isNull(field)
      case 'is_not_null':
        return isNotNull(field)
      case 'starts_with':
        if (value == null) return null
        return ilike(field, likeStartsWith(value))
      case 'ends_with':
        if (value == null) return null
        return ilike(field, likeEndsWith(value))
      case 'between':
        if (value && value2) {
          return and(gte(field, value), lte(field, value2)) ?? null
        }
        return null
      default:
        return null
    }
  }

  /**
   * Get a field reference from a field path
   */
  private static getFieldFromPath(
    fieldPath: string,
    itemType: ItemType,
    typeTable:
      | typeof parts
      | typeof documents
      | typeof changeOrders
      | typeof requirements
      | typeof tasks
      | typeof testPlans
      | typeof testCases
      | typeof issues,
  ): SQL | ReturnType<typeof sql.raw> | null {
    const pathParts = fieldPath.split('.')

    if (pathParts.length === 1) {
      // Base table field (single-segment path — the whole path is the field)
      const baseField = (items as unknown as Record<string, unknown>)[fieldPath]
      if (baseField) {
        return baseField as SQL
      }
    } else if (pathParts.length === 2) {
      // Type-specific table field
      const [tableName, fieldName] = pathParts
      if (tableName === undefined || fieldName === undefined) return null
      const expectedTable = tableName.toLowerCase()

      // Map table name to actual table
      const tableNameMap: Record<string, string> = {
        parts: 'Part',
        documents: 'Document',
        change_orders: 'ChangeOrder',
        changeorders: 'ChangeOrder',
        requirements: 'Requirement',
        tasks: 'Task',
        test_plans: 'TestPlan',
        testplans: 'TestPlan',
        test_cases: 'TestCase',
        testcases: 'TestCase',
        issues: 'Issue',
      }

      const mappedType = tableNameMap[expectedTable]
      if (
        mappedType === itemType ||
        expectedTable === itemType.toLowerCase() + 's'
      ) {
        const typeField = (typeTable as unknown as Record<string, unknown>)[
          fieldName
        ]
        if (typeField) {
          return typeField as SQL
        }
      }
    }

    return null
  }

  /**
   * Get a value from a query result row using a field path
   */
  private static getValueFromPath(
    fieldPath: string,
    row: Record<string, unknown>,
    _itemType: ItemType,
  ): unknown {
    const pathParts = fieldPath.split('.')

    if (pathParts.length === 1) {
      // Base table field - data is in 'items' key
      const itemsData = row.items as Record<string, unknown> | undefined
      return itemsData?.[fieldPath]
    } else if (pathParts.length === 2) {
      // Type-specific table field
      const [tableName, fieldName] = pathParts
      if (tableName === undefined || fieldName === undefined) return undefined

      // Get the type-specific data from the row
      // The key matches the table name (e.g., 'parts', 'documents')
      const tableKey = tableName.toLowerCase()
      const typeData = row[tableKey] as Record<string, unknown> | undefined

      return typeData?.[fieldName]
    }

    return undefined
  }

  /**
   * Enrich a report with its columns, filters, and sorts
   * @param report - The base report to enrich
   * @param dbCtx - Optional database context (transaction or db instance). Defaults to global db.
   */
  private static async enrichReport(
    report: typeof reports.$inferSelect,
    dbCtx: typeof db = db,
  ): Promise<Report> {
    const [columnsResult, filtersResult, sortsResult] = await Promise.all([
      dbCtx
        .select()
        .from(reportColumns)
        .where(eq(reportColumns.reportId, report.id))
        .orderBy(asc(reportColumns.displayOrder)),
      dbCtx
        .select()
        .from(reportFilters)
        .where(eq(reportFilters.reportId, report.id))
        .orderBy(asc(reportFilters.displayOrder)),
      dbCtx
        .select()
        .from(reportSorts)
        .where(eq(reportSorts.reportId, report.id))
        .orderBy(asc(reportSorts.priority)),
    ])

    return {
      ...report,
      columns: columnsResult as Array<ReportColumn>,
      filters: filtersResult as Array<ReportFilter>,
      sorts: sortsResult as Array<ReportSort>,
    }
  }

  /**
   * Export report results to CSV
   */
  static exportToCSV(result: ReportExecutionResult): string {
    const { columns, rows } = result

    // Build header row using column labels
    const visibleColumns = columns.filter((c) => c.isVisible !== false)
    const headers = visibleColumns.map((c) => this.escapeCSV(c.label))
    const headerRow = headers.join(',')

    // Build data rows
    const dataRows = rows.map((row) => {
      return visibleColumns
        .map((col) => {
          const value = row[col.fieldPath]
          return this.escapeCSV(this.formatValue(value, col.formatType))
        })
        .join(',')
    })

    return [headerRow, ...dataRows].join('\n')
  }

  /**
   * Escape a value for CSV
   */
  private static escapeCSV(value: string | null | undefined): string {
    if (value == null) {
      return ''
    }

    const stringValue = String(value)

    // If value contains comma, quote, or newline, wrap in quotes and escape quotes
    if (
      stringValue.includes(',') ||
      stringValue.includes('"') ||
      stringValue.includes('\n')
    ) {
      return `"${stringValue.replace(/"/g, '""')}"`
    }

    return stringValue
  }

  /**
   * Format a value based on its format type
   */
  private static formatValue(
    value: unknown,
    formatType?: string | null,
  ): string {
    if (value === null || value === undefined) {
      return ''
    }

    switch (formatType) {
      case 'date':
        if (value instanceof Date) {
          return value.toLocaleDateString()
        }
        if (typeof value === 'string') {
          return new Date(value).toLocaleDateString()
        }
        return String(value)

      case 'datetime':
        if (value instanceof Date) {
          return value.toLocaleString()
        }
        if (typeof value === 'string') {
          return new Date(value).toLocaleString()
        }
        return String(value)

      case 'currency':
        if (typeof value === 'number') {
          return value.toLocaleString('en-US', {
            style: 'currency',
            currency: 'USD',
          })
        }
        return String(value)

      case 'number':
        if (typeof value === 'number') {
          return value.toLocaleString()
        }
        return String(value)

      case 'percentage':
        if (typeof value === 'number') {
          return `${(value * 100).toFixed(1)}%`
        }
        return String(value)

      case 'boolean':
        return (value as boolean) ? 'Yes' : 'No'

      default:
        return String(value)
    }
  }

  /**
   * Record an export in the report_exports audit table
   */
  static async recordExport(params: {
    reportId: string
    executionId?: string
    exportedBy: string
    format: string
    fileName: string
    fileSize: number
  }): Promise<void> {
    await db.insert(reportExports).values({
      reportId: params.reportId,
      executionId: params.executionId ?? null,
      exportedBy: params.exportedBy,
      format: params.format,
      fileName: params.fileName,
      fileSize: params.fileSize,
      storagePath: null,
    })
  }
}
