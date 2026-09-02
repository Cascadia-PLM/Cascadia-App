// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
import { likeContains } from '../../db/like-pattern'
import {
  changeOrders,
  designs,
  documents,
  issues,
  items,
  parts,
  programs,
  requirements,
  software,
  tasks,
  testCases,
  testPlans,
  workInstructions,
} from '../../db/schema'
import { accessScopeCondition, notDeleted } from '../../db/filters'
import type { AccessScope } from '../../db/filters'
import type { SQL } from 'drizzle-orm'
import type { BaseItem } from '../types/base'
import { paginatedOrderBy } from '@/lib/db/paginated-order'

export interface SearchCriteria {
  query?: string
  state?: string
  createdBy?: string
  designId?: string // Filter by single design
  designIds?: Array<string> // Filter by multiple designs (for cross-design search)
  /**
   * What the *caller* may read, as opposed to what they asked for.
   *
   * A separate axis from `designIds` on purpose, and ANDed with it: a user
   * narrowing the view to one design must not thereby widen it past their
   * program memberships. `null`/omitted is unrestricted (cross-program
   * authority); an empty scope reaches only the types that scope on nothing.
   *
   * Omitting it returns every item in the instance, so a route serving a
   * logged-in user should pass it — see `AccessControlService.getAccessScope`.
   */
  accessScope?: AccessScope | null
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

export interface GlobalSearchCriteria {
  /** Free-text term matched against itemNumber and name. Optional — filters alone are a valid search. */
  query?: string
  /**
   * Item types to include. The caller is responsible for intersecting this
   * with the types the user may read; an empty array matches nothing.
   */
  itemTypes: Array<string>
  /**
   * What the user may see, or `null` for unrestricted (cross-program
   * authority). An empty scope reaches only the types that scope on nothing —
   * "no accessible designs" must not fall through to "search every design".
   */
  accessScope: AccessScope | null
  limit?: number
  offset?: number
  sortField?: string
  sortDirection?: 'asc' | 'desc'
  /**
   * Column filters keyed by grid column id. Base item columns behave as in
   * `search`; `program` filters on the owning design's programId and
   * `design` on the item's designId (exact match, since their values are ids
   * picked from a dropdown rather than typed text).
   */
  columnFilters?: Record<
    string,
    string | Array<string> | { min?: number; max?: number }
  >
}

export interface GlobalSearchRow extends BaseItem {
  designCode: string | null
  designName: string | null
  programId: string | null
  programCode: string | null
  programName: string | null
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

    // Filter by multiple designs (for cross-design search). An explicitly
    // empty set matches nothing: a scope that resolved to no designs must not
    // fall through to searching every design.
    if (criteria.designIds) {
      conditions.push(
        criteria.designIds.length > 0
          ? inArray(items.designId, criteria.designIds)
          : sql`false`,
      )
    }

    const searchAccessScope = accessScopeCondition(criteria.accessScope)
    if (searchAccessScope) conditions.push(searchAccessScope)

    // Global search: full-text search for 3+ chars, ILIKE fallback for short queries
    if (criteria.globalSearch && criteria.globalSearch.trim()) {
      const term = criteria.globalSearch.trim()

      if (term.length >= 3) {
        // Build tsquery with prefix matching: "PRT 001" -> "PRT:* & 001:*"
        const words = term
          .replace(/[^a-zA-Z0-9\s\-_]/g, '') // Strip tsquery-unsafe characters
          .split(/\s+/)
          .filter(Boolean)
        if (words.length === 0) {
          // A term that is nothing but punctuation matches nothing, rather
          // than falling through and matching everything.
          conditions.push(sql`false`)
        } else {
          const tsquery = words.map((w) => `${w}:*`).join(' & ')
          conditions.push(
            sql`to_tsvector('simple', coalesce(${items.itemNumber}, '') || ' ' || coalesce(${items.name}, ''))
              @@ to_tsquery('simple', ${tsquery})`,
          )
        }
      } else {
        const searchTerm = likeContains(term)
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
        // `??` not `||`: an explicit 0 must not silently become the default
        .limit(criteria.limit ?? 50)
        .offset(criteria.offset ?? 0)
    } else {
      const rawResults = await db
        .select()
        .from(items)
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(criteria.limit ?? 50)
        .offset(criteria.offset ?? 0)
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
          const usageRows = await db
            .select({ count: sql<number>`count(*)` })
            .from(items)
            .where(eq(items.usageOf, item.id))
          usageCount = Number(usageRows[0]?.count ?? 0)
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
      const countRows = await db
        .select({ count: sql<number>`count(*)` })
        .from(items)
        .leftJoin(typeTable, eq(typeTable.itemId, items.id))
        .where(and(...conditions))
      totalCount = Number(countRows[0]?.count ?? 0)
    } else {
      const countRows = await db
        .select({ count: sql<number>`count(*)` })
        .from(items)
        .where(and(...conditions))
      totalCount = Number(countRows[0]?.count ?? 0)
    }

    return {
      items: enrichedItems,
      total: totalCount,
    }
  }

  /**
   * Resolve an exact set of item numbers to their ids, keyed by lowercased
   * item number.
   *
   * Distinct from `searchByItemNumber`, which is a ranked text search with a
   * row limit. Callers that already know which item numbers they need — bulk
   * import wiring up BOM relationships, say — must not page through a search
   * and hope their targets are on the first page. Lookup is by exact number,
   * so the result is complete for the set asked about however large the
   * design is.
   */
  static async findIdsByItemNumbers(
    itemNumbers: Array<string>,
    options?: { designIds?: Array<string>; currentOnly?: boolean },
  ): Promise<Map<string, string>> {
    const wanted = [
      ...new Set(
        itemNumbers.map((n) => n.trim().toLowerCase()).filter(Boolean),
      ),
    ]
    if (wanted.length === 0) return new Map()

    const conditions = [
      inArray(sql`lower(${items.itemNumber})`, wanted),
      notDeleted(),
    ]

    if (options?.currentOnly !== false) {
      conditions.push(eq(items.isCurrent, true))
    }

    if (options?.designIds) {
      conditions.push(
        options.designIds.length > 0
          ? inArray(items.designId, options.designIds)
          : sql`false`,
      )
    }

    const rows = await db
      .select({ id: items.id, itemNumber: items.itemNumber })
      .from(items)
      .where(and(...conditions))

    const byNumber = new Map<string, string>()
    for (const row of rows) {
      if (!row.itemNumber) continue
      const key = row.itemNumber.toLowerCase()
      // First writer wins, so a caller's own freshly-created items (seeded
      // into the map before this lookup) are never displaced by an older one
      if (!byNumber.has(key)) byNumber.set(key, row.id)
    }
    return byNumber
  }

  /**
   * Search for items by item number or name
   * Used for autocomplete in affected items manager
   */
  static async searchByItemNumber(
    query: string,
    options?: {
      limit?: number
      offset?: number
      itemTypes?: Array<string>
      currentOnly?: boolean
      designIds?: Array<string> // Filter by multiple designs (for cross-design search)
      /** What the caller may read; `null`/omitted is unrestricted. See `SearchCriteria`. */
      accessScope?: AccessScope | null
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
      const searchTerm = likeContains(query)
      searchCondition = or(
        ilike(items.itemNumber, searchTerm),
        ilike(items.name, searchTerm),
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
        or(...options.itemTypes.map((type) => eq(items.itemType, type))),
      )
    }

    // Filter by multiple designs (for cross-design search). An explicitly
    // empty set matches nothing — see the note in `search`.
    if (options?.designIds) {
      conditions.push(
        options.designIds.length > 0
          ? inArray(items.designId, options.designIds)
          : sql`false`,
      )
    }

    const byNumberAccessScope = accessScopeCondition(options?.accessScope)
    if (byNumberAccessScope) conditions.push(byNumberAccessScope)

    const results = await db
      .select()
      .from(items)
      .where(and(...conditions))
      // `itemNumber` carries no uniqueness constraint, so it cannot close the
      // order on its own.
      .orderBy(...paginatedOrderBy(asc(items.itemNumber), items.id))
      // `??` not `||`: an explicit 0 must not silently become the default
      .limit(options?.limit ?? 20)
      .offset(options?.offset ?? 0)

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

  /**
   * Cross-type search for the enterprise search results page.
   *
   * One SQL query over the base `items` table joined to `designs` and
   * `programs`, so results page through a single real total and can be
   * sorted/filtered on the item's design and program. Only base item
   * columns are sortable/filterable — type-specific columns would need a
   * per-type join, which cross-type paging cannot express.
   */
  static async searchGlobal(
    criteria: GlobalSearchCriteria,
  ): Promise<SearchResult<GlobalSearchRow>> {
    const conditions: Array<SQL<unknown>> = [
      notDeleted(),
      eq(items.isCurrent, true),
      // Definitions only: usages would show the same item once per structure
      isNull(items.usageOf),
    ]

    // An empty readable-type set matches nothing — see GlobalSearchCriteria.
    conditions.push(
      criteria.itemTypes.length > 0
        ? inArray(items.itemType, criteria.itemTypes)
        : sql`false`,
    )
    const globalAccessScope = accessScopeCondition(criteria.accessScope)
    if (globalAccessScope) conditions.push(globalAccessScope)

    const textCondition = this.buildTextSearchCondition(criteria.query)
    if (textCondition === 'no-match') {
      return { items: [], total: 0 }
    }
    if (textCondition) {
      conditions.push(textCondition)
    }

    if (criteria.columnFilters) {
      for (const [columnId, filterValue] of Object.entries(
        criteria.columnFilters,
      )) {
        const condition = this.buildGlobalFilterCondition(columnId, filterValue)
        if (condition) {
          conditions.push(condition)
        }
      }
    }

    const orderBy = this.buildGlobalOrderByClause(criteria)

    const rows = await db
      .select({
        item: items,
        designCode: designs.code,
        designName: designs.name,
        programId: designs.programId,
        programCode: programs.code,
        programName: programs.name,
      })
      .from(items)
      .leftJoin(designs, eq(items.designId, designs.id))
      .leftJoin(programs, eq(designs.programId, programs.id))
      .where(and(...conditions))
      .orderBy(...orderBy)
      .limit(criteria.limit || 25)
      .offset(criteria.offset || 0)

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(items)
      .leftJoin(designs, eq(items.designId, designs.id))
      .leftJoin(programs, eq(designs.programId, programs.id))
      .where(and(...conditions))
    const total = Number(countRows[0]?.count ?? 0)

    return {
      items: rows.map(
        ({
          item,
          designCode,
          designName,
          programId,
          programCode,
          programName,
        }) =>
          ({
            ...item,
            designCode,
            designName,
            programId,
            programCode,
            programName,
          }) as GlobalSearchRow,
      ),
      total,
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Free-text condition over itemNumber and name: prefix-matched full-text
   * for 3+ chars (with tsquery-unsafe characters stripped), ILIKE for
   * shorter terms. Returns `'no-match'` when sanitising removed the whole
   * term — such a query can match nothing, not everything.
   */
  private static buildTextSearchCondition(
    query: string | undefined,
  ): SQL<unknown> | 'no-match' | null {
    const term = query?.trim()
    if (!term) return null

    if (term.length >= 3) {
      const words = term
        .replace(/[^a-zA-Z0-9\s\-_]/g, '') // Strip tsquery-unsafe characters
        .split(/\s+/)
        .filter(Boolean)
      if (words.length === 0) {
        return 'no-match'
      }
      const tsquery = words.map((w) => `${w}:*`).join(' & ')
      return sql`to_tsvector('simple', coalesce(${items.itemNumber}, '') || ' ' || coalesce(${items.name}, ''))
        @@ to_tsquery('simple', ${tsquery})`
    }

    const searchTerm = likeContains(term)
    return or(
      ilike(items.itemNumber, searchTerm),
      ilike(items.name, searchTerm),
    ) as SQL<unknown>
  }

  /** Column filters available on the cross-type search grid. */
  private static buildGlobalFilterCondition(
    columnId: string,
    filterValue: string | Array<string> | { min?: number; max?: number },
  ): SQL<unknown> | null {
    const baseColumns: Record<string, any> = {
      itemNumber: items.itemNumber,
      name: items.name,
      state: items.state,
      revision: items.revision,
      itemType: items.itemType,
    }
    if (baseColumns[columnId]) {
      return this.buildFilterForColumn(baseColumns[columnId], filterValue)
    }

    // Program and design filters carry ids picked from a dropdown; match
    // them exactly rather than via ILIKE.
    const idColumns: Record<string, any> = {
      program: designs.programId,
      design: items.designId,
    }
    const idColumn = idColumns[columnId]
    if (!idColumn) return null
    if (typeof filterValue === 'string') {
      return filterValue.trim() ? eq(idColumn, filterValue.trim()) : null
    }
    if (Array.isArray(filterValue)) {
      return filterValue.length > 0 ? inArray(idColumn, filterValue) : null
    }
    return null
  }

  /** ORDER BY for the cross-type search grid: base columns plus the joined design/program identity. */
  private static buildGlobalOrderByClause(
    criteria: GlobalSearchCriteria,
  ): Array<SQL<unknown>> {
    const direction = criteria.sortDirection === 'asc' ? asc : desc

    const sortColumns: Record<string, any> = {
      itemNumber: items.itemNumber,
      name: items.name,
      state: items.state,
      revision: items.revision,
      itemType: items.itemType,
      createdAt: items.createdAt,
      modifiedAt: items.modifiedAt,
      program: programs.name,
      design: designs.code,
    }

    const column = criteria.sortField
      ? sortColumns[criteria.sortField]
      : undefined
    if (!column) {
      // Deterministic default matching the header dropdown's ordering
      return paginatedOrderBy(asc(items.itemNumber), items.id)
    }
    // `itemNumber` is unique in practice but carries no constraint saying so,
    // so the id still closes the order.
    return paginatedOrderBy(
      [direction(column), asc(items.itemNumber)],
      items.id,
    )
  }

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
      case 'Software':
        return software
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
      Requirement: ['description', 'type', 'priority', 'category'],
      Task: ['description', 'assignee', 'priority', 'dueDate'],
      ChangeOrder: ['changeType', 'priority', 'reasonForChange'],
      TestPlan: ['scope', 'environment'],
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
      Software: [
        'description',
        'softwareType',
        'sourceMode',
        'version',
        'targetHardware',
        'toolchain',
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
      Software: {
        description: software.description,
        softwareType: software.softwareType,
        sourceMode: software.sourceMode,
        version: software.version,
        targetHardware: software.targetHardware,
        toolchain: software.toolchain,
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
      return ilike(column, likeContains(filterValue.trim()))
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
      // Default sort: createdAt descending. `created_at` is the transaction
      // timestamp, so a seed, a bulk import or an ECO merge writes a whole run
      // of rows sharing it exactly — which is why the tiebreaker matters most
      // on the default path.
      return paginatedOrderBy(desc(items.createdAt), items.id)
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
      Software: {
        description: software.description,
        softwareType: software.softwareType,
        sourceMode: software.sourceMode,
        version: software.version,
        targetHardware: software.targetHardware,
        toolchain: software.toolchain,
      },
    }

    // Check base columns
    if (baseColumns[criteria.sortField]) {
      return paginatedOrderBy(
        direction(baseColumns[criteria.sortField]),
        items.id,
      )
    }

    // Check type-specific columns
    const typeColumns = typeColumnMaps[type]
    if (typeColumns?.[criteria.sortField]) {
      return paginatedOrderBy(
        direction(typeColumns[criteria.sortField]),
        items.id,
      )
    }

    // Fallback to default sort
    return paginatedOrderBy(desc(items.createdAt), items.id)
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
      case 'Software': {
        const [sw] = await db
          .select()
          .from(software)
          .where(eq(software.itemId, itemId))
          .limit(1)
        return sw
      }
      default:
        return null
    }
  }
}
