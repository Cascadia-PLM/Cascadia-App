// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm'
import { db } from '../../db'
import {
  changeOrders,
  documents,
  issues,
  items,
  parts,
  requirements,
  tasks,
  testCases,
  testPlans,
  workInstructions,
} from '../../db/schema'
import { notDeleted } from '../../db/filters'
import type { SQL } from 'drizzle-orm'
import type { BaseItem } from '../types/base'

export interface SearchCriteria {
  query?: string
  state?: string
  createdBy?: string
  designId?: string // Filter by single design
  designIds?: Array<string> // Filter by multiple designs (for cross-design search)
  currentOnly?: boolean // Only return isCurrent=true items (default: true)
  definitionsOnly?: boolean // Only return definitions (usageOf IS NULL), excludes usages
  includeUsageCount?: boolean // Include count of usages for each definition
  limit?: number
  offset?: number

  // Server-side sorting
  sortField?: string
  sortDirection?: 'asc' | 'desc'

  // Column filters - supports text (string), multiSelect (string[]), and range ({ min?: number; max?: number })
  columnFilters?: Record<
    string,
    string | Array<string> | { min?: number; max?: number }
  >

  // Global search (ILIKE across multiple columns)
  globalSearch?: string
}

export interface SearchResult<T = any> {
  items: Array<T>
  total: number
}

/**
 * Service layer for item search operations
 * Extracted from ItemService to keep search logic separate from CRUD operations
 */
export class ItemSearchService {
  /**
   * Search items
   *
   * By default, only returns current items (isCurrent=true) to avoid showing
   * both master items and working copies. Set currentOnly=false to include all.
   *
   * Use definitionsOnly=true for global pages (/parts, /documents) to show only
   * definitions (canonical items) and exclude usages. Combine with includeUsageCount=true
   * to show how many designs use each definition.
   *
   * Supports server-side sorting, column filters, and global search for efficient
   * pagination over large datasets.
   */
  static async search<T = any>(
    type: string,
    criteria: SearchCriteria,
  ): Promise<SearchResult<T>> {
    // Build where conditions
    const conditions: Array<SQL<unknown>> = [
      eq(items.itemType, type),
      notDeleted(),
    ]

    // Only return current revisions by default (avoid duplicates from working copies)
    if (criteria.currentOnly !== false) {
      conditions.push(eq(items.isCurrent, true))
    }

    // Filter for definitions only (usageOf IS NULL)
    // This excludes usage items, showing only canonical definitions
    if (criteria.definitionsOnly) {
      conditions.push(isNull(items.usageOf))
    }

    if (criteria.state) {
      conditions.push(eq(items.state, criteria.state))
    }

    if (criteria.createdBy) {
      conditions.push(eq(items.createdBy, criteria.createdBy))
    }

    if (criteria.designId) {
      conditions.push(eq(items.designId, criteria.designId))
    }

    // Filter by multiple designs (for cross-design search)
    if (criteria.designIds && criteria.designIds.length > 0) {
      conditions.push(inArray(items.designId, criteria.designIds))
    }

    // Global search: full-text search for 3+ chars, ILIKE fallback for short queries
    if (criteria.globalSearch && criteria.globalSearch.trim()) {
      const term = criteria.globalSearch.trim()

      if (term.length >= 3) {
        // Build tsquery with prefix matching: "PRT 001" -> "PRT:* & 001:*"
        const tsquery = term
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => `${w}:*`)
          .join(' & ')
        conditions.push(
          sql`to_tsvector('simple', coalesce(${items.itemNumber}, '') || ' ' || coalesce(${items.name}, ''))
            @@ to_tsquery('simple', ${tsquery})`,
        )
      } else {
        const searchTerm = `%${term}%`
        conditions.push(
          or(
            ilike(items.itemNumber, searchTerm),
            ilike(items.name, searchTerm),
          ) as SQL<unknown>,
        )
      }
    }

    // Column filters
    if (criteria.columnFilters) {
      for (const [columnId, filterValue] of Object.entries(
        criteria.columnFilters,
      )) {

        // Map column IDs to actual database columns
        const columnCondition = this.buildColumnFilterCondition(
          type,
          columnId,
          filterValue,
        )
        if (columnCondition) {
          conditions.push(columnCondition)
        }
      }
    }

    // Build ORDER BY clause based on sortField
    const orderBy = this.buildOrderByClause(type, criteria)

    // Join with type-specific table for filtering/sorting on those fields
    const typeTable = this.getTypeTable(type)

    let results
    if (typeTable) {
      results = await db
        .select({
          item: items,
          typeData: typeTable,
        })
        .from(items)
        .leftJoin(typeTable, eq(typeTable.itemId, items.id))
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(criteria.limit || 50)
        .offset(criteria.offset || 0)
    } else {
      const rawResults = await db
        .select()
        .from(items)
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(criteria.limit || 50)
        .offset(criteria.offset || 0)
      results = rawResults.map((item) => ({ item, typeData: null }))
    }

    // Enrich items with type-specific data (already joined, but keeping same output format)
    const enrichedItems = await Promise.all(
      results.map(async ({ item, typeData }) => {
        // Use joined data if available, otherwise fetch
        const typeSpecificData =
          typeData || (await this.getTypeSpecificData(type, item.id))

        // Optionally count usages of this definition
        let usageCount: number | undefined
        if (criteria.includeUsageCount) {
          const [{ count }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(items)
            .where(eq(items.usageOf, item.id))
          usageCount = Number(count)
        }

        return {
          ...item,
          ...typeSpecificData,
          ...(usageCount !== undefined ? { usageCount } : {}),
        }
      }),
    )

    // Get total count with same conditions (but without join for efficiency)
    let totalCount: number
    if (
      typeTable &&
      this.hasTypeSpecificFilters(criteria.columnFilters, type)
    ) {
      // Need to join for accurate count when filtering on type-specific columns
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(items)
        .leftJoin(typeTable, eq(typeTable.itemId, items.id))
        .where(and(...conditions))
      totalCount = Number(count)
    } else {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(items)
        .where(and(...conditions))
      totalCount = Number(count)
    }

    return {
      items: enrichedItems,
      total: totalCount,
    }
  }

  /**
   * Search for items by item number or name
   * Used for autocomplete in affected items manager
   */
  static async searchByItemNumber(
    query: string,
    options?: {
      limit?: number
      itemTypes?: Array<string>
      currentOnly?: boolean
      designIds?: Array<string> // Filter by multiple designs (for cross-design search)
    },
  ): Promise<Array<BaseItem>> {
    if (!query || query.length < 2) {
      return []
    }

    // Full-text search for 3+ chars, ILIKE fallback for short queries
    let searchCondition
    if (query.length >= 3) {
      const words = query
        .replace(/[^a-zA-Z0-9\s\-_]/g, '') // Strip tsquery-unsafe characters
        .split(/\s+/)
        .filter(Boolean)
      if (words.length === 0) {
        return []
      }
      const tsquery = words.map((w) => `${w}:*`).join(' & ')
      searchCondition = sql`to_tsvector('simple', coalesce(${items.itemNumber}, '') || ' ' || coalesce(${items.name}, ''))
        @@ to_tsquery('simple', ${tsquery})`
    } else {
      searchCondition = or(
        ilike(items.itemNumber, `%${query}%`),
        ilike(items.name, `%${query}%`),
      )
    }

    const conditions = [searchCondition, notDeleted()]

    // Only return current revisions by default
    if (options?.currentOnly !== false) {
      conditions.push(eq(items.isCurrent, true))
    }

    // Filter by item types if specified
    if (options?.itemTypes && options.itemTypes.length > 0) {
      conditions.push(
        or(...options.itemTypes.map((type) => eq(items.itemType, type))) as any,
      )
    }

    // Filter by multiple designs (for cross-design search)
    if (options?.designIds && options.designIds.length > 0) {
      conditions.push(inArray(items.designId, options.designIds))
    }

    const results = await db
      .select()
      .from(items)
      .where(and(...conditions))
      .orderBy(items.itemNumber)
      .limit(options?.limit || 20)

    // Enrich with type-specific data
    const enrichedItems = await Promise.all(
      results.map(async (item) => {
        const typeSpecificData = await this.getTypeSpecificData(
          item.itemType,
          item.id,
        )
        return { ...item, ...typeSpecificData }
      }),
    )

    return enrichedItems
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Get the type-specific table for a given item type
   */
  private static getTypeTable(type: string) {
    switch (type) {
      case 'Part':
        return parts
      case 'Document':
        return documents
      case 'Requirement':
        return requirements
      case 'Task':
        return tasks
      case 'ChangeOrder':
        return changeOrders
      case 'TestPlan':
        return testPlans
      case 'TestCase':
        return testCases
      case 'Issue':
        return issues
      case 'WorkInstruction':
        return workInstructions
      default:
        return null
    }
  }

  /**
   * Check if column filters include type-specific columns
   */
  private static hasTypeSpecificFilters(
    columnFilters: SearchCriteria['columnFilters'],
    type: string,
  ): boolean {
    if (!columnFilters) return false

    const typeSpecificColumns: Record<string, Array<string>> = {
      Part: [
        'description',
        'partType',
        'material',
        'weight',
        'cost',
        'leadTimeDays',
      ],
      Document: ['description', 'fileName', 'mimeType'],
      Requirement: ['description', 'type', 'priority', 'status', 'category'],
      Task: ['description', 'assignee', 'priority', 'dueDate'],
      ChangeOrder: ['changeType', 'priority', 'reasonForChange'],
      TestPlan: ['scope', 'environment', 'status'],
      TestCase: ['testType', 'executionStatus'],
      Issue: [
        'description',
        'severity',
        'priority',
        'category',
        'assignedTo',
        'resolution',
        'rootCause',
      ],
      WorkInstruction: [
        'description',
        'estimatedTime',
        'difficulty',
        'safetyNotes',
        'requiredTools',
      ],
    }

    const columns = typeSpecificColumns[type] || []
    return Object.keys(columnFilters).some((col) => columns.includes(col))
  }

  /**
   * Build column filter condition based on column ID and filter value
   */
  private static buildColumnFilterCondition(
    type: string,
    columnId: string,
    filterValue: string | Array<string> | { min?: number; max?: number },
  ): SQL<unknown> | null {
    // Map column IDs to database columns
    // Base item columns
    const baseColumns: Record<string, any> = {
      itemNumber: items.itemNumber,
      name: items.name,
      state: items.state,
      revision: items.revision,
    }

    // Type-specific column mappings for all item types
    const typeColumnMaps: Record<string, Record<string, any>> = {
      Part: {
        description: parts.description,
        partType: parts.partType,
        material: parts.material,
        weight: parts.weight,
        cost: parts.cost,
        costCurrency: parts.costCurrency,
        leadTimeDays: parts.leadTimeDays,
      },
      Document: {
        description: documents.description,
        fileName: documents.fileName,
        mimeType: documents.mimeType,
        fileSize: documents.fileSize,
      },
      Requirement: {
        description: requirements.description,
        type: requirements.type,
        priority: requirements.priority,
        status: requirements.status,
        category: requirements.category,
        verificationMethod: requirements.verificationMethod,
        verificationStatus: requirements.verificationStatus,
      },
      Task: {
        description: tasks.description,
        assignee: tasks.assignee,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        estimatedHours: tasks.estimatedHours,
        actualHours: tasks.actualHours,
      },
      ChangeOrder: {
        changeType: changeOrders.changeType,
        priority: changeOrders.priority,
        reasonForChange: changeOrders.reasonForChange,
        riskLevel: changeOrders.riskLevel,
        impactAssessmentStatus: changeOrders.impactAssessmentStatus,
      },
      TestPlan: {
        scope: testPlans.scope,
        environment: testPlans.environment,
        status: testPlans.status,
      },
      TestCase: {
        testType: testCases.testType,
        executionStatus: testCases.executionStatus,
        environment: testCases.environment,
      },
      Issue: {
        description: issues.description,
        severity: issues.severity,
        priority: issues.priority,
        category: issues.category,
        assignedTo: issues.assignedTo,
        resolution: issues.resolution,
        rootCause: issues.rootCause,
      },
      WorkInstruction: {
        description: workInstructions.description,
        estimatedTime: workInstructions.estimatedTime,
        difficulty: workInstructions.difficulty,
        safetyNotes: workInstructions.safetyNotes,
        requiredTools: workInstructions.requiredTools,
      },
    }

    // Check base columns first
    if (baseColumns[columnId]) {
      const column = baseColumns[columnId]
      return this.buildFilterForColumn(column, filterValue)
    }

    // Check type-specific columns
    const typeColumns = typeColumnMaps[type]
    if (typeColumns?.[columnId]) {
      return this.buildFilterForColumn(typeColumns[columnId], filterValue)
    }

    return null
  }

  /**
   * Build filter SQL for a specific column and value
   */
  private static buildFilterForColumn(
    column: any,
    filterValue: string | Array<string> | { min?: number; max?: number },
  ): SQL<unknown> | null {
    // Text filter (ILIKE)
    if (typeof filterValue === 'string') {
      if (!filterValue.trim()) return null
      return ilike(column, `%${filterValue.trim()}%`)
    }

    // Multi-select filter (IN)
    if (Array.isArray(filterValue)) {
      if (filterValue.length === 0) return null
      return inArray(column, filterValue)
    }

    // Range filter (>= min AND <= max)
    if (typeof filterValue === 'object') {
      const { min, max } = filterValue
      const rangeConditions: Array<SQL<unknown>> = []

      if (min !== undefined) {
        rangeConditions.push(gte(column, min))
      }
      if (max !== undefined) {
        rangeConditions.push(lte(column, max))
      }

      if (rangeConditions.length === 0) return null
      return and(...rangeConditions) as SQL<unknown>
    }

    return null
  }

  /**
   * Build ORDER BY clause based on sort criteria
   */
  private static buildOrderByClause(
    type: string,
    criteria: SearchCriteria,
  ): Array<SQL<unknown>> {
    if (!criteria.sortField) {
      // Default sort: createdAt descending
      return [desc(items.createdAt)]
    }

    const direction = criteria.sortDirection === 'asc' ? asc : desc

    // Map sort field to database column
    // Base item columns
    const baseColumns: Record<string, any> = {
      itemNumber: items.itemNumber,
      name: items.name,
      state: items.state,
      revision: items.revision,
      createdAt: items.createdAt,
      modifiedAt: items.modifiedAt,
    }

    // Type-specific column mappings for all item types
    const typeColumnMaps: Record<string, Record<string, any>> = {
      Part: {
        description: parts.description,
        partType: parts.partType,
        material: parts.material,
        weight: parts.weight,
        cost: parts.cost,
        leadTimeDays: parts.leadTimeDays,
      },
      Document: {
        description: documents.description,
        fileName: documents.fileName,
        mimeType: documents.mimeType,
        fileSize: documents.fileSize,
      },
      Requirement: {
        description: requirements.description,
        type: requirements.type,
        priority: requirements.priority,
        status: requirements.status,
        category: requirements.category,
        verificationMethod: requirements.verificationMethod,
        verificationStatus: requirements.verificationStatus,
      },
      Task: {
        description: tasks.description,
        assignee: tasks.assignee,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        estimatedHours: tasks.estimatedHours,
        actualHours: tasks.actualHours,
      },
      ChangeOrder: {
        changeType: changeOrders.changeType,
        priority: changeOrders.priority,
        reasonForChange: changeOrders.reasonForChange,
        riskLevel: changeOrders.riskLevel,
        impactAssessmentStatus: changeOrders.impactAssessmentStatus,
      },
      TestPlan: {
        scope: testPlans.scope,
        environment: testPlans.environment,
        status: testPlans.status,
      },
      TestCase: {
        testType: testCases.testType,
        executionStatus: testCases.executionStatus,
        environment: testCases.environment,
      },
      Issue: {
        description: issues.description,
        severity: issues.severity,
        priority: issues.priority,
        category: issues.category,
        assignedTo: issues.assignedTo,
        resolution: issues.resolution,
        rootCause: issues.rootCause,
      },
      WorkInstruction: {
        description: workInstructions.description,
        estimatedTime: workInstructions.estimatedTime,
        difficulty: workInstructions.difficulty,
        safetyNotes: workInstructions.safetyNotes,
        requiredTools: workInstructions.requiredTools,
      },
    }

    // Check base columns
    if (baseColumns[criteria.sortField]) {
      return [direction(baseColumns[criteria.sortField])]
    }

    // Check type-specific columns
    const typeColumns = typeColumnMaps[type]
    if (typeColumns?.[criteria.sortField]) {
      return [direction(typeColumns[criteria.sortField])]
    }

    // Fallback to default sort
    return [desc(items.createdAt)]
  }

  /**
   * Get type-specific data for an item (used internally by search methods for enrichment)
   */
  private static async getTypeSpecificData(
    type: string,
    itemId: string,
  ): Promise<any> {
    switch (type) {
      case 'Part': {
        const [part] = await db
          .select()
          .from(parts)
          .where(eq(parts.itemId, itemId))
          .limit(1)
        return part
      }
      case 'Document': {
        const [doc] = await db
          .select()
          .from(documents)
          .where(eq(documents.itemId, itemId))
          .limit(1)
        return doc
      }
      case 'Requirement': {
        const [requirement] = await db
          .select()
          .from(requirements)
          .where(eq(requirements.itemId, itemId))
          .limit(1)
        return requirement
      }
      case 'Task': {
        const [task] = await db
          .select()
          .from(tasks)
          .where(eq(tasks.itemId, itemId))
          .limit(1)
        return task
      }
      case 'ChangeOrder': {
        const [co] = await db
          .select()
          .from(changeOrders)
          .where(eq(changeOrders.itemId, itemId))
          .limit(1)
        return co
      }
      case 'TestPlan': {
        const [tp] = await db
          .select()
          .from(testPlans)
          .where(eq(testPlans.itemId, itemId))
          .limit(1)
        return tp
      }
      case 'TestCase': {
        const [tc] = await db
          .select()
          .from(testCases)
          .where(eq(testCases.itemId, itemId))
          .limit(1)
        return tc
      }
      case 'Issue': {
        const [issue] = await db
          .select()
          .from(issues)
          .where(eq(issues.itemId, itemId))
          .limit(1)
        return issue
      }
      default:
        return null
    }
  }
}
