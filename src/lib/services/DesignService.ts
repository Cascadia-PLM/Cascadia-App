// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { branches, commits, designs, items, tags } from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import type { SQL } from 'drizzle-orm'

// Zod schemas for validation
export const designCreateSchema = z.object({
  programId: z.string().uuid().optional().nullable(),
  name: z.string().min(1, 'Name is required').max(200),
  code: z
    .string()
    .min(1, 'Code is required')
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  description: z.string().optional().nullable(),
  designType: z
    .enum(['Engineering', 'Library', 'Family'])
    .optional()
    .default('Engineering'),
  parentDesignId: z.string().uuid().optional().nullable(),
  cloneSourceDesignId: z.string().uuid().optional().nullable(),
  plannedQuantity: z.number().int().positive().optional().nullable(),
  attributes: z.record(z.string(), z.unknown()).optional(),
})

export const designUpdateSchema = designCreateSchema
  .partial()
  .omit({ designType: true })

export const tagCreateSchema = z.object({
  name: z.string().min(1, 'Tag name is required').max(100),
  description: z.string().optional(),
  tagType: z
    .enum(['baseline', 'release', 'milestone', 'eco-release'])
    .optional()
    .default('baseline'),
})

export type CreateDesignInput = z.infer<typeof designCreateSchema>
export type UpdateDesignInput = z.infer<typeof designUpdateSchema>
export type CreateTagInput = z.infer<typeof tagCreateSchema>

export interface DesignFilters {
  programId?: string
  designType?: 'Engineering' | 'Library' | 'Family'
  includeArchived?: boolean
  includeHierarchy?: boolean
  limit?: number
  offset?: number
}

/**
 * Search criteria for database-level filtering
 */
export interface DesignSearchCriteria {
  /** Pagination */
  limit?: number
  offset?: number
  /** Sorting */
  sortField?: string
  sortDirection?: 'asc' | 'desc'
  /** Global search across code, name, description */
  globalSearch?: string
  /** Column-specific filters */
  columnFilters?: Record<
    string,
    string | Array<string> | { min?: number; max?: number }
  >
  /** Filter by program IDs (for access control) */
  programIds?: Array<string> | null // null means "all programs" (admin)
  /** Include archived designs */
  includeArchived?: boolean
  /** Include global libraries (no program) */
  includeGlobalLibraries?: boolean
  /** Include unassigned designs (no program, type=Engineering) */
  includeUnassigned?: boolean
}

export interface DesignSearchResult {
  items: Array<typeof designs.$inferSelect>
  total: number
}

/**
 * Service for managing Designs, Branches, and Tags
 */
export class DesignService {
  /**
   * Validate that a parent design is valid for the given child design
   * Rules:
   * - Parent must exist
   * - Parent must be a 'family' type
   * - Parent must be in the same program (or both null)
   * - Child cannot be a 'family' type (no nested families)
   */
  static async validateParentDesign(
    parentId: string,
    childProgramId: string | null | undefined,
    childDesignType: string,
  ): Promise<void> {
    // Families cannot have parents (no nested families)
    if (childDesignType === 'Family') {
      throw new ValidationError(
        'Family designs cannot have a parent',
        undefined,
        {
          field: 'parentDesignId',
        },
      )
    }

    // Fetch parent design
    const parent = await this.getById(parentId)
    if (!parent) {
      throw new ValidationError('Parent design not found', undefined, {
        field: 'parentDesignId',
      })
    }

    // Parent must be a family type
    if (parent.designType !== 'Family') {
      throw new ValidationError(
        'Parent design must be a family type',
        undefined,
        {
          field: 'parentDesignId',
        },
      )
    }

    // Same program rule (both null or both same value)
    const parentProgramId = parent.programId ?? null
    const childProgram = childProgramId ?? null
    if (parentProgramId !== childProgram) {
      throw new ValidationError(
        'Parent and child designs must be in the same program',
        undefined,
        {
          field: 'parentDesignId',
        },
      )
    }
  }

  /**
   * Create a new design with main branch and initial commit
   */
  static async create(data: CreateDesignInput, userId: string) {
    const validated = designCreateSchema.parse(data)

    // Check for duplicate code (system-wide unique)
    const existing = await db
      .select({ id: designs.id })
      .from(designs)
      .where(eq(designs.code, validated.code))
      .limit(1)

    if (existing.length > 0) {
      throw new ValidationError('Design code already exists', undefined, {
        field: 'code',
      })
    }

    // Validate parent design if provided
    if (validated.parentDesignId) {
      await this.validateParentDesign(
        validated.parentDesignId,
        validated.programId,
        validated.designType,
      )
    }

    const designType = validated.designType

    // Family designs don't have branches/commits - they're just containers
    if (designType === 'Family') {
      const [design] = await db
        .insert(designs)
        .values({
          programId: validated.programId,
          name: validated.name,
          code: validated.code,
          description: validated.description,
          designType: 'Family',
          parentDesignId: validated.parentDesignId,
          cloneSourceDesignId: validated.cloneSourceDesignId,
          plannedQuantity: validated.plannedQuantity,
          attributes: validated.attributes || {},
          createdBy: userId,
        })
        .returning()

      return {
        ...design,
        mainBranch: null,
        initialCommit: null,
      }
    }

    // Use a transaction to ensure atomicity for regular designs
    return db.transaction(async (tx) => {
      // 1. Insert design
      const [design] = await tx
        .insert(designs)
        .values({
          programId: validated.programId,
          name: validated.name,
          code: validated.code,
          description: validated.description,
          designType: designType,
          parentDesignId: validated.parentDesignId,
          cloneSourceDesignId: validated.cloneSourceDesignId,
          plannedQuantity: validated.plannedQuantity,
          attributes: validated.attributes || {},
          createdBy: userId,
        })
        .returning()

      // 2. Create initial commit (with temporary branchId)
      const [initialCommit] = await tx
        .insert(commits)
        .values({
          designId: design.id,
          branchId: design.id, // Temporary - will update after branch creation
          message: 'Initial commit',
          createdBy: userId,
        })
        .returning()

      // 3. Create main branch pointing to initial commit
      const [mainBranch] = await tx
        .insert(branches)
        .values({
          designId: design.id,
          name: 'main',
          branchType: 'main',
          headCommitId: initialCommit.id,
          baseCommitId: initialCommit.id,
          createdBy: userId,
        })
        .returning()

      // 4. Update commit with correct branchId
      await tx
        .update(commits)
        .set({ branchId: mainBranch.id })
        .where(eq(commits.id, initialCommit.id))

      // 5. Update design with default branch
      const [updatedDesign] = await tx
        .update(designs)
        .set({ defaultBranchId: mainBranch.id })
        .where(eq(designs.id, design.id))
        .returning()

      return {
        ...updatedDesign,
        mainBranch,
        initialCommit: { ...initialCommit, branchId: mainBranch.id },
      }
    })
  }

  /**
   * Get design by ID
   */
  static async getById(id: string) {
    const result = await db
      .select()
      .from(designs)
      .where(eq(designs.id, id))
      .limit(1)

    return result.at(0) || null
  }

  /**
   * Get design by code (system-wide unique)
   */
  static async getByCode(code: string) {
    const result = await db
      .select()
      .from(designs)
      .where(eq(designs.code, code))
      .limit(1)

    return result.at(0) || null
  }

  /**
   * Update a design
   */
  static async update(id: string, data: UpdateDesignInput, userId: string) {
    const validated = designUpdateSchema.parse(data)

    const existing = await this.getById(id)
    if (!existing) {
      throw new NotFoundError('Design', id, { operation: 'update' })
    }

    // Check for duplicate code if code is being changed (system-wide unique)
    if (validated.code && validated.code !== existing.code) {
      const duplicate = await db
        .select({ id: designs.id })
        .from(designs)
        .where(eq(designs.code, validated.code))
        .limit(1)

      if (duplicate.length > 0) {
        throw new ValidationError('Design code already exists', undefined, {
          field: 'code',
        })
      }
    }

    const [updated] = await db
      .update(designs)
      .set({
        ...validated,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(designs.id, id))
      .returning()

    return updated
  }

  /**
   * Archive a design (soft delete)
   */
  static async archive(id: string, _userId: string) {
    const existing = await this.getById(id)
    if (!existing) {
      throw new NotFoundError('Design', id, { operation: 'archive' })
    }

    // Don't allow archiving the Standard Library
    if (existing.designType === 'Library') {
      throw new ValidationError('Cannot archive the Standard Library')
    }

    await db
      .update(designs)
      .set({ isArchived: true, updatedAt: new Date() })
      .where(eq(designs.id, id))
  }

  /**
   * List all designs (for Global Admins)
   */
  static async listAll(filters?: DesignFilters) {
    const conditions: Array<ReturnType<typeof eq>> = []

    if (filters?.programId) {
      conditions.push(eq(designs.programId, filters.programId))
    }
    if (filters?.designType) {
      conditions.push(eq(designs.designType, filters.designType))
    }
    if (!filters?.includeArchived) {
      conditions.push(eq(designs.isArchived, false))
    }

    const limit = filters?.limit || 50
    const offset = filters?.offset || 0

    const result = await db
      .select()
      .from(designs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(designs.createdAt))
      .limit(limit)
      .offset(offset)

    return result
  }

  /**
   * List designs by program
   */
  static async listByProgram(programId: string) {
    return db
      .select()
      .from(designs)
      .where(
        and(eq(designs.programId, programId), eq(designs.isArchived, false)),
      )
      .orderBy(desc(designs.createdAt))
  }

  /**
   * List designs by multiple program IDs
   */
  static async listByProgramIds(programIds: Array<string>) {
    if (programIds.length === 0) {
      return []
    }

    return db
      .select()
      .from(designs)
      .where(
        and(
          inArray(designs.programId, programIds),
          eq(designs.isArchived, false),
        ),
      )
      .orderBy(desc(designs.createdAt))
  }

  /**
   * List global libraries (designs with no program and type = 'library')
   * These are accessible to all authenticated users
   */
  static async listGlobalLibraries() {
    return db
      .select()
      .from(designs)
      .where(
        and(
          isNull(designs.programId),
          eq(designs.designType, 'Library'),
          eq(designs.isArchived, false),
        ),
      )
      .orderBy(desc(designs.createdAt))
  }

  /**
   * List unassigned designs (designs with no program and type = 'design')
   * These are accessible to all authenticated users until assigned to a program
   */
  static async listUnassigned() {
    return db
      .select()
      .from(designs)
      .where(
        and(
          isNull(designs.programId),
          eq(designs.designType, 'Engineering'),
          eq(designs.isArchived, false),
        ),
      )
      .orderBy(desc(designs.createdAt))
  }

  /**
   * Search designs with database-level filtering, sorting, and pagination
   * Supports global search, column filters, and access control
   */
  static async search(
    criteria: DesignSearchCriteria,
  ): Promise<DesignSearchResult> {
    const conditions: Array<SQL<unknown>> = []

    // Archived filter (default: exclude archived)
    if (!criteria.includeArchived) {
      conditions.push(eq(designs.isArchived, false))
    }

    // Access control: filter by program IDs
    // null = admin (all programs), empty array = no access, array = specific programs
    if (criteria.programIds !== null) {
      const accessConditions: Array<SQL<unknown>> = []

      // User's programs
      if (criteria.programIds && criteria.programIds.length > 0) {
        accessConditions.push(inArray(designs.programId, criteria.programIds))
      }

      // Global libraries (no program, type=library)
      if (criteria.includeGlobalLibraries !== false) {
        accessConditions.push(
          and(
            isNull(designs.programId),
            eq(designs.designType, 'Library'),
          ) as SQL<unknown>,
        )
      }

      // Unassigned designs (no program, type=design)
      if (criteria.includeUnassigned !== false) {
        accessConditions.push(
          and(
            isNull(designs.programId),
            eq(designs.designType, 'Engineering'),
          ) as SQL<unknown>,
        )
      }

      if (accessConditions.length > 0) {
        conditions.push(or(...accessConditions) as SQL<unknown>)
      } else {
        // No access at all - return empty
        return { items: [], total: 0 }
      }
    }

    // Global search: ILIKE across code, name, description
    if (criteria.globalSearch && criteria.globalSearch.trim()) {
      const searchTerm = `%${criteria.globalSearch.trim()}%`
      conditions.push(
        or(
          ilike(designs.code, searchTerm),
          ilike(designs.name, searchTerm),
          ilike(designs.description, searchTerm),
        ) as SQL<unknown>,
      )
    }

    // Column filters
    if (criteria.columnFilters) {
      for (const [columnId, filterValue] of Object.entries(
        criteria.columnFilters,
      )) {
        if (filterValue === '') continue

        const columnCondition = this.buildColumnFilterCondition(
          columnId,
          filterValue,
        )
        if (columnCondition) {
          conditions.push(columnCondition)
        }
      }
    }

    // Build ORDER BY clause
    const orderBy = this.buildOrderByClause(criteria)

    // Execute query with pagination
    const results = await db
      .select()
      .from(designs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(...orderBy)
      .limit(criteria.limit || 50)
      .offset(criteria.offset || 0)

    // Get total count with same conditions
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(designs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)

    return {
      items: results,
      total: countResult.count,
    }
  }

  /**
   * Build filter SQL for a specific column
   */
  private static buildColumnFilterCondition(
    columnId: string,
    filterValue: string | Array<string> | { min?: number; max?: number },
  ): SQL<unknown> | null {
    // Get column by ID
    const column = this.getColumnById(columnId)
    if (!column) return null

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

    return null
  }

  /**
   * Get a database column by its ID for filtering/sorting
   */
  private static getColumnById(columnId: string) {
    switch (columnId) {
      case 'code':
        return designs.code
      case 'name':
        return designs.name
      case 'description':
        return designs.description
      case 'designType':
        return designs.designType
      case 'programId':
        return designs.programId
      case 'createdAt':
        return designs.createdAt
      case 'updatedAt':
        return designs.updatedAt
      default:
        return null
    }
  }

  /**
   * Build ORDER BY clause based on sort criteria
   */
  private static buildOrderByClause(
    criteria: DesignSearchCriteria,
  ): Array<SQL<unknown>> {
    if (!criteria.sortField) {
      // Default sort: createdAt descending
      return [desc(designs.createdAt)]
    }

    const direction = criteria.sortDirection === 'asc' ? asc : desc
    const column = this.getColumnById(criteria.sortField)

    if (column) {
      return [direction(column)]
    }

    // Fallback to default sort
    return [desc(designs.createdAt)]
  }

  // ============================================================================
  // Branch Operations
  // ============================================================================

  /**
   * Get all branches for a design
   */
  static async getBranches(designId: string, includeArchived = false) {
    const design = await this.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, { operation: 'getBranches' })
    }

    const conditions = [eq(branches.designId, designId)]
    if (!includeArchived) {
      conditions.push(eq(branches.isArchived, false))
    }

    return db
      .select()
      .from(branches)
      .where(and(...conditions))
      .orderBy(desc(branches.createdAt))
  }

  /**
   * Get the default (main) branch for a design
   */
  static async getDefaultBranch(designId: string) {
    const design = await this.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'getDefaultBranch',
      })
    }

    if (!design.defaultBranchId) {
      return null
    }

    const result = await db
      .select()
      .from(branches)
      .where(eq(branches.id, design.defaultBranchId))
      .limit(1)

    return result.at(0) || null
  }

  /**
   * Get a branch by ID
   */
  static async getBranch(branchId: string) {
    const result = await db
      .select()
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1)

    return result.at(0) || null
  }

  // ============================================================================
  // Protection Status
  // ============================================================================

  /**
   * Get the protection status of a design.
   * Determines whether design is in pre-release or post-release phase.
   */
  static async getProtectionStatus(designId: string): Promise<{
    designId: string
    phase: 'pre-release' | 'post-release'
    hasReleasedItems: boolean
    releasedItemCount: number
    draftItemCount: number
    totalItemCount: number
    isMainBranchProtected: boolean
  }> {
    const design = await this.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'getProtectionStatus',
      })
    }

    // Count items by state
    const stateCounts = await db
      .select({
        state: items.state,
        count: sql<number>`count(*)::int`,
      })
      .from(items)
      .where(eq(items.designId, designId))
      .groupBy(items.state)

    let releasedItemCount = 0
    let draftItemCount = 0
    let totalItemCount = 0

    for (const row of stateCounts) {
      totalItemCount += row.count
      if (row.state === 'Released') releasedItemCount = row.count
      if (row.state === 'Draft') draftItemCount = row.count
    }

    const hasReleasedItems = releasedItemCount > 0

    return {
      designId,
      phase: hasReleasedItems ? 'post-release' : 'pre-release',
      hasReleasedItems,
      releasedItemCount,
      draftItemCount,
      totalItemCount,
      isMainBranchProtected: hasReleasedItems,
    }
  }

  // ============================================================================
  // Tag Operations
  // ============================================================================

  /**
   * Create a tag (baseline) for a design
   */
  static async createTag(
    designId: string,
    data: CreateTagInput,
    userId: string,
  ) {
    const validated = tagCreateSchema.parse(data)

    const design = await this.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, { operation: 'createTag' })
    }

    // Check for duplicate tag name
    const existing = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.designId, designId), eq(tags.name, validated.name)))
      .limit(1)

    if (existing.length > 0) {
      throw new ValidationError(
        'Tag name already exists for this design',
        undefined,
        {
          field: 'name',
        },
      )
    }

    // Get the HEAD commit of the main branch
    const mainBranch = await this.getDefaultBranch(designId)
    if (!mainBranch || !mainBranch.headCommitId) {
      throw new ValidationError('Design has no main branch or commits')
    }

    const [tag] = await db
      .insert(tags)
      .values({
        designId,
        name: validated.name,
        description: validated.description,
        commitId: mainBranch.headCommitId,
        tagType: validated.tagType,
        createdBy: userId,
      })
      .returning()

    return tag
  }

  /**
   * List all tags for a design
   */
  static async listTags(designId: string) {
    const design = await this.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, { operation: 'listTags' })
    }

    return db
      .select()
      .from(tags)
      .where(eq(tags.designId, designId))
      .orderBy(desc(tags.createdAt))
  }

  /**
   * Get a tag by ID
   */
  static async getTag(tagId: string) {
    const result = await db
      .select()
      .from(tags)
      .where(eq(tags.id, tagId))
      .limit(1)

    return result.at(0) || null
  }

  /**
   * Delete a tag by ID
   */
  static async deleteTag(tagId: string) {
    const tag = await this.getTag(tagId)
    if (!tag) {
      throw new NotFoundError('Tag', tagId)
    }

    await db.delete(tags).where(eq(tags.id, tagId))

    return { success: true }
  }

  // ============================================================================
  // Standard Library
  // ============================================================================

  /**
   * Create the Standard Library (global, accessible to all users)
   */
  static async createStandardLibrary(userId: string) {
    // Check if Standard Library already exists
    const existing = await this.getStandardLibrary()
    if (existing) {
      throw new ValidationError('Standard Library already exists')
    }

    // Create the Standard Library design
    const result = await this.create(
      {
        programId: null, // Not associated with any program (global)
        name: 'Standard Library',
        code: 'STD-LIB',
        description:
          'Global standard parts and components accessible to all users',
        designType: 'Library',
      },
      userId,
    )

    return result
  }

  /**
   * Get the Standard Library (global)
   */
  static async getStandardLibrary() {
    const library = await db
      .select()
      .from(designs)
      .where(
        and(
          isNull(designs.programId),
          eq(designs.designType, 'Library'),
          eq(designs.code, 'STD-LIB'),
        ),
      )
      .limit(1)

    return library.at(0) || null
  }

  // ============================================================================
  // Design Hierarchy (Family Support)
  // ============================================================================

  /**
   * Get member designs of a family
   * Returns child designs with item count and release status
   */
  static async getMembers(familyId: string) {
    const family = await this.getById(familyId)
    if (!family) {
      throw new NotFoundError('Design', familyId, { operation: 'getMembers' })
    }

    if (family.designType !== 'Family') {
      throw new ValidationError(
        'Only family designs can have members',
        undefined,
        {
          field: 'designType',
        },
      )
    }

    // Get child designs
    const children = await db
      .select()
      .from(designs)
      .where(
        and(
          eq(designs.parentDesignId, familyId),
          eq(designs.isArchived, false),
        ),
      )
      .orderBy(designs.code)

    // Get item counts and release status for each child
    const membersWithCounts = await Promise.all(
      children.map(async (child) => {
        // Count items
        const [countResult] = await db
          .select({
            totalCount: sql<number>`count(*)::int`,
            releasedCount: sql<number>`count(*) filter (where ${items.state} = 'Released')::int`,
          })
          .from(items)
          .where(eq(items.designId, child.id))

        // Get latest tag
        const [latestTag] = await db
          .select({ name: tags.name })
          .from(tags)
          .where(eq(tags.designId, child.id))
          .orderBy(desc(tags.createdAt))
          .limit(1)

        return {
          ...child,
          itemCount: countResult.totalCount,
          hasReleases: countResult.releasedCount > 0,
          latestTag: latestTag?.name ?? null,
        }
      }),
    )

    return membersWithCounts
  }

  /**
   * Set or change the parent family of a design
   */
  static async setParent(
    designId: string,
    parentDesignId: string | null,
    _userId: string,
  ) {
    const design = await this.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, { operation: 'setParent' })
    }

    // Validate parent if setting one
    if (parentDesignId) {
      // Can't set parent to self
      if (parentDesignId === designId) {
        throw new ValidationError(
          'Design cannot be its own parent',
          undefined,
          {
            field: 'parentDesignId',
          },
        )
      }

      await this.validateParentDesign(
        parentDesignId,
        design.programId,
        design.designType,
      )
    }

    // Update the design
    const [updated] = await db
      .update(designs)
      .set({
        parentDesignId: parentDesignId,
        updatedAt: new Date(),
      })
      .where(eq(designs.id, designId))
      .returning()

    return updated
  }

  /**
   * Remove a design from its family (sets parentDesignId to null)
   */
  static async removeFromFamily(designId: string, userId: string) {
    return this.setParent(designId, null, userId)
  }

  /**
   * List designs with hierarchy structure
   * Returns families with their children nested, plus standalone designs
   */
  static async listWithHierarchy(filters?: DesignFilters) {
    const conditions: Array<ReturnType<typeof eq>> = []

    if (filters?.programId) {
      conditions.push(eq(designs.programId, filters.programId))
    }
    if (filters?.designType) {
      conditions.push(eq(designs.designType, filters.designType))
    }
    if (!filters?.includeArchived) {
      conditions.push(eq(designs.isArchived, false))
    }

    // Get all designs
    const allDesigns = await db
      .select()
      .from(designs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(designs.code)

    // Build hierarchy
    const families = allDesigns.filter((d) => d.designType === 'Family')
    const childrenByParent = new Map<string, typeof allDesigns>()
    const standaloneDesigns: typeof allDesigns = []

    for (const design of allDesigns) {
      if (design.designType === 'Family') continue

      if (design.parentDesignId) {
        const children = childrenByParent.get(design.parentDesignId) || []
        children.push(design)
        childrenByParent.set(design.parentDesignId, children)
      } else {
        standaloneDesigns.push(design)
      }
    }

    // Build result with nested structure
    const result = [
      ...families.map((family) => ({
        ...family,
        children: childrenByParent.get(family.id) || [],
      })),
      ...standaloneDesigns.map((design) => ({
        ...design,
        children: [],
      })),
    ]

    // Apply pagination
    const offset = filters?.offset || 0
    const limit = filters?.limit || 100
    return result.slice(offset, offset + limit)
  }

  /**
   * Get families available for a design to join
   * Filters to families in the same program
   */
  static async getAvailableFamilies(programId: string | null) {
    const conditions = [
      eq(designs.designType, 'Family'),
      eq(designs.isArchived, false),
    ]

    if (programId) {
      conditions.push(eq(designs.programId, programId))
    } else {
      conditions.push(isNull(designs.programId))
    }

    return db
      .select()
      .from(designs)
      .where(and(...conditions))
      .orderBy(designs.code)
  }
}
