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
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '../db'
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
      const [report] = await tx
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
        .returning()

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

      // Replace columns (required in input)
      await tx.delete(reportColumns).where(eq(reportColumns.reportId, reportId))
      if (data.columns && data.columns.length > 0) {
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

      // Replace filters (defaults to [])
      await tx.delete(reportFilters).where(eq(reportFilters.reportId, reportId))
      if (data.filters && data.filters.length > 0) {
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

      // Replace sorts (defaults to [])
      await tx.delete(reportSorts).where(eq(reportSorts.reportId, reportId))
      if (data.sorts && data.sorts.length > 0) {
        await tx.insert(reportSorts).values(
          data.sorts.map((sort) => ({
            reportId,
            fieldPath: sort.fieldPath,
            direction: sort.direction,
            priority: sort.priority,
          })),
        )
      }

      const results = await tx
        .select()
        .from(reports)
        .where(eq(reports.id, reportId))
        .limit(1)
      if (results.length === 0) {
        throw new Error('Report not found after update')
      }

      return this.enrichReport(results[0], tx)
    })
  }

  /**
   * Delete a report (cascade handles children)
   */
  static async delete(reportId: string): Promise<void> {
    await db.delete(reports).where(eq(reports.id, reportId))
  }

  /**
   * Find a report by ID with enriched children
   */
  static async findById(reportId: string): Promise<Report | null> {
    const result = await db
      .select()
      .from(reports)
      .where(eq(reports.id, reportId))
      .limit(1)
    if (result.length === 0) {
      return null
    }
    return this.enrichReport(result[0])
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
   * List reports accessible to the user with server-side pagination
   */
  static async list(
    userId: string,
    userRoles: Array<string> = [],
    options?: { limit?: number; offset?: number },
  ): Promise<{ reports: Array<Report>; total: number }> {
    const accessConditions = this.buildAccessConditions(userId, userRoles)
    const whereClause = or(...accessConditions)

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reports)
      .where(whereClause)

    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const result = await db
      .select()
      .from(reports)
      .where(whereClause)
      .orderBy(desc(reports.modifiedAt))
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
    userRoles: Array<string> = [],
    options?: { limit?: number; offset?: number },
  ): Promise<{ reports: Array<Report>; total: number }> {
    const accessConditions = this.buildAccessConditions(userId, userRoles)
    const whereClause = and(
      or(...accessConditions),
      eq(reports.itemType, itemType),
    )

    const [{ count: total }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(reports)
      .where(whereClause)

    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const result = await db
      .select()
      .from(reports)
      .where(whereClause)
      .orderBy(desc(reports.modifiedAt))
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

    const report = await this.findById(reportId)
    if (!report) {
      throw new Error('Report not found')
    }

    try {
      const result = await this.buildAndExecuteQuery(report, options)
      const durationMs = Date.now() - startTime

      // Log execution
      const [execution] = await db
        .insert(reportExecutions)
        .values({
          reportId,
          executedBy: userId,
          rowCount: result.totalRows,
          durationMs,
          parameters: options as Record<string, unknown>,
          success: true,
        })
        .returning()

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
    options: ReportExecutionOptions = {},
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
      .orderBy(...sortOrder)
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
      case 'like':
        return ilike(field, `%${value}%`)
      case 'not_like':
        return sql`${field} NOT ILIKE ${'%' + value + '%'}`
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
        return ilike(field, `${value}%`)
      case 'ends_with':
        return ilike(field, `%${value}`)
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
      // Base table field
      const fieldName = pathParts[0]
      const baseField = (items as unknown as Record<string, unknown>)[fieldName]
      if (baseField) {
        return baseField as SQL
      }
    } else if (pathParts.length === 2) {
      // Type-specific table field
      const [tableName, fieldName] = pathParts
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
      return itemsData?.[pathParts[0]]
    } else if (pathParts.length === 2) {
      // Type-specific table field
      const [tableName, fieldName] = pathParts

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
