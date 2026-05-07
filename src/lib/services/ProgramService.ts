// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { programMembers, programs } from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import type { SQL } from 'drizzle-orm'

// Zod schemas for validation
export const programCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  code: z
    .string()
    .min(1, 'Code is required')
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  description: z.string().optional(),
  contractNumber: z.string().max(100).optional(),
  customer: z.string().max(200).optional(),
  startDate: z.coerce.date().optional(),
  targetEndDate: z.coerce.date().optional(),
  status: z.enum(['Active', 'On Hold', 'Completed', 'Cancelled']).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
})

export const programUpdateSchema = programCreateSchema.partial()

export type CreateProgramInput = z.infer<typeof programCreateSchema>
export type UpdateProgramInput = z.infer<typeof programUpdateSchema>

export type ProgramRole = 'admin' | 'lead' | 'engineer' | 'viewer'

export interface ProgramMemberUpdate {
  role?: ProgramRole
  canCreateEco?: boolean
  canApproveEco?: boolean
  canManageProducts?: boolean
}

export interface ProgramFilters {
  status?: string
  limit?: number
  offset?: number
}

/**
 * Search criteria for database-level filtering
 */
export interface ProgramSearchCriteria {
  /** Pagination */
  limit?: number
  offset?: number
  /** Sorting */
  sortField?: string
  sortDirection?: 'asc' | 'desc'
  /** Global search across code, name, description, customer */
  globalSearch?: string
  /** Column-specific filters */
  columnFilters?: Record<
    string,
    string | Array<string> | { min?: number; max?: number }
  >
  /** Filter by program IDs (for access control) */
  programIds?: Array<string> | null // null means "all programs" (admin)
}

export interface ProgramSearchResult {
  items: Array<typeof programs.$inferSelect>
  total: number
}

/**
 * Service for managing Programs and Program Membership
 */
export class ProgramService {
  /**
   * Create a new program
   */
  static async create(data: CreateProgramInput, userId: string) {
    // Validate input
    const validated = programCreateSchema.parse(data)

    // Check for duplicate code (system-wide unique)
    const existing = await db
      .select({ id: programs.id })
      .from(programs)
      .where(eq(programs.code, validated.code))
      .limit(1)

    if (existing.length > 0) {
      throw new ValidationError('Program code already exists', undefined, {
        field: 'code',
      })
    }

    // Insert program
    const [program] = await db
      .insert(programs)
      .values({
        name: validated.name,
        code: validated.code,
        description: validated.description,
        contractNumber: validated.contractNumber,
        customer: validated.customer,
        startDate: validated.startDate,
        targetEndDate: validated.targetEndDate,
        status: validated.status || 'Active',
        attributes: validated.attributes || {},
        createdBy: userId,
        updatedBy: userId,
      })
      .returning()

    // Automatically add creator as admin
    await db.insert(programMembers).values({
      programId: program.id,
      userId: userId,
      role: 'admin',
      canCreateEco: true,
      canApproveEco: true,
      canManageProducts: true,
      invitedBy: userId,
    })

    return program
  }

  /**
   * Get program by ID
   */
  static async getById(id: string) {
    const result = await db
      .select()
      .from(programs)
      .where(eq(programs.id, id))
      .limit(1)

    return result.at(0) || null
  }

  /**
   * Update a program
   */
  static async update(id: string, data: UpdateProgramInput, userId: string) {
    const validated = programUpdateSchema.parse(data)

    const existing = await this.getById(id)
    if (!existing) {
      throw new NotFoundError('Program', id, { operation: 'update' })
    }

    // Prevent updates to programs in terminal states
    const terminalStatuses = ['Completed', 'Cancelled']
    if (terminalStatuses.includes(existing.status)) {
      throw new ValidationError(
        `Cannot update a program with status '${existing.status}'`,
      )
    }

    // Check for duplicate code if code is being changed (system-wide unique)
    if (validated.code && validated.code !== existing.code) {
      const duplicate = await db
        .select({ id: programs.id })
        .from(programs)
        .where(eq(programs.code, validated.code))
        .limit(1)

      if (duplicate.length > 0) {
        throw new ValidationError('Program code already exists', undefined, {
          field: 'code',
        })
      }
    }

    const [updated] = await db
      .update(programs)
      .set({
        ...validated,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(programs.id, id))
      .returning()

    return updated
  }

  /**
   * Delete a program
   */
  static async delete(id: string) {
    const existing = await this.getById(id)
    if (!existing) {
      throw new NotFoundError('Program', id, { operation: 'delete' })
    }

    await db.delete(programs).where(eq(programs.id, id))
  }

  /**
   * List all programs (for Global Admins)
   */
  static async listAll(filters?: ProgramFilters) {
    const limit = filters?.limit || 50
    const offset = filters?.offset || 0

    const result = filters?.status
      ? await db
          .select()
          .from(programs)
          .where(eq(programs.status, filters.status))
          .orderBy(desc(programs.createdAt))
          .limit(limit)
          .offset(offset)
      : await db
          .select()
          .from(programs)
          .orderBy(desc(programs.createdAt))
          .limit(limit)
          .offset(offset)

    return result
  }

  /**
   * List programs accessible by a user
   */
  static async listByUser(userId: string) {
    const memberships = await db
      .select({
        program: programs,
        role: programMembers.role,
      })
      .from(programMembers)
      .innerJoin(programs, eq(programMembers.programId, programs.id))
      .where(eq(programMembers.userId, userId))
      .orderBy(desc(programs.createdAt))

    return memberships.map((m) => ({
      ...m.program,
      userRole: m.role,
    }))
  }

  /**
   * Search programs with database-level filtering, sorting, and pagination
   * Supports global search, column filters, and access control
   */
  static async search(
    criteria: ProgramSearchCriteria,
  ): Promise<ProgramSearchResult> {
    const conditions: Array<SQL<unknown>> = []

    // Access control: filter by program IDs
    // null = admin (all programs), array = specific programs
    if (criteria.programIds !== null) {
      if (criteria.programIds && criteria.programIds.length > 0) {
        conditions.push(inArray(programs.id, criteria.programIds))
      } else {
        // No access at all - return empty
        return { items: [], total: 0 }
      }
    }

    // Global search: ILIKE across code, name, description, customer
    if (criteria.globalSearch && criteria.globalSearch.trim()) {
      const searchTerm = `%${criteria.globalSearch.trim()}%`
      conditions.push(
        or(
          ilike(programs.code, searchTerm),
          ilike(programs.name, searchTerm),
          ilike(programs.description, searchTerm),
          ilike(programs.customer, searchTerm),
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
      .from(programs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(...orderBy)
      .limit(criteria.limit || 50)
      .offset(criteria.offset || 0)

    // Get total count with same conditions
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(programs)
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
        return programs.code
      case 'name':
        return programs.name
      case 'description':
        return programs.description
      case 'status':
        return programs.status
      case 'customer':
        return programs.customer
      case 'contractNumber':
        return programs.contractNumber
      case 'startDate':
        return programs.startDate
      case 'targetEndDate':
        return programs.targetEndDate
      case 'createdAt':
        return programs.createdAt
      case 'updatedAt':
        return programs.updatedAt
      default:
        return null
    }
  }

  /**
   * Build ORDER BY clause based on sort criteria
   */
  private static buildOrderByClause(
    criteria: ProgramSearchCriteria,
  ): Array<SQL<unknown>> {
    if (!criteria.sortField) {
      // Default sort: createdAt descending
      return [desc(programs.createdAt)]
    }

    const direction = criteria.sortDirection === 'asc' ? asc : desc
    const column = this.getColumnById(criteria.sortField)

    if (column) {
      return [direction(column)]
    }

    // Fallback to default sort
    return [desc(programs.createdAt)]
  }

  // ============================================================================
  // Membership Management
  // ============================================================================

  /**
   * Add a member to a program
   */
  static async addMember(
    programId: string,
    userId: string,
    role: ProgramRole,
    invitedBy: string,
  ) {
    const program = await this.getById(programId)
    if (!program) {
      throw new NotFoundError('Program', programId, { operation: 'addMember' })
    }

    // Check if already a member
    const existing = await this.getMember(programId, userId)
    if (existing) {
      throw new ValidationError(
        'User is already a member of this program',
        undefined,
        {
          field: 'userId',
        },
      )
    }

    // Set default permissions based on role
    const permissions = this.getDefaultPermissions(role)

    const [member] = await db
      .insert(programMembers)
      .values({
        programId,
        userId,
        role,
        canCreateEco: permissions.canCreateEco,
        canApproveEco: permissions.canApproveEco,
        canManageProducts: permissions.canManageProducts,
        invitedBy,
      })
      .returning()

    return member
  }

  /**
   * Update a program member's role or permissions
   */
  static async updateMember(
    programId: string,
    userId: string,
    updates: ProgramMemberUpdate,
  ) {
    const existing = await this.getMember(programId, userId)
    if (!existing) {
      throw new NotFoundError('Program member', `${programId}/${userId}`, {
        operation: 'updateMember',
      })
    }

    const [updated] = await db
      .update(programMembers)
      .set(updates)
      .where(
        and(
          eq(programMembers.programId, programId),
          eq(programMembers.userId, userId),
        ),
      )
      .returning()

    return updated
  }

  /**
   * Remove a member from a program
   */
  static async removeMember(programId: string, userId: string) {
    const existing = await this.getMember(programId, userId)
    if (!existing) {
      throw new NotFoundError('Program member', `${programId}/${userId}`, {
        operation: 'removeMember',
      })
    }

    // Prevent removing the last admin
    if (existing.role === 'admin') {
      const adminCount = await db
        .select({ id: programMembers.id })
        .from(programMembers)
        .where(
          and(
            eq(programMembers.programId, programId),
            eq(programMembers.role, 'admin'),
          ),
        )

      if (adminCount.length <= 1) {
        throw new ValidationError('Cannot remove the last admin from a program')
      }
    }

    await db
      .delete(programMembers)
      .where(
        and(
          eq(programMembers.programId, programId),
          eq(programMembers.userId, userId),
        ),
      )
  }

  /**
   * Get a specific member
   */
  static async getMember(programId: string, userId: string) {
    const result = await db
      .select()
      .from(programMembers)
      .where(
        and(
          eq(programMembers.programId, programId),
          eq(programMembers.userId, userId),
        ),
      )
      .limit(1)

    return result.at(0) || null
  }

  /**
   * List all members of a program
   */
  static async listMembers(programId: string) {
    const program = await this.getById(programId)
    if (!program) {
      throw new NotFoundError('Program', programId, {
        operation: 'listMembers',
      })
    }

    return db
      .select()
      .from(programMembers)
      .where(eq(programMembers.programId, programId))
      .orderBy(programMembers.joinedAt)
  }

  /**
   * Check if a user can access a program
   */
  static async canUserAccess(
    userId: string,
    programId: string,
  ): Promise<boolean> {
    const member = await this.getMember(programId, userId)
    return member !== null
  }

  /**
   * Get a user's role in a program
   */
  static async getUserRole(
    userId: string,
    programId: string,
  ): Promise<ProgramRole | null> {
    const member = await this.getMember(programId, userId)
    return member ? (member.role as ProgramRole) : null
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private static getDefaultPermissions(role: ProgramRole) {
    switch (role) {
      case 'admin':
        return {
          canCreateEco: true,
          canApproveEco: true,
          canManageProducts: true,
        }
      case 'lead':
        return {
          canCreateEco: true,
          canApproveEco: true,
          canManageProducts: false,
        }
      case 'engineer':
        return {
          canCreateEco: true,
          canApproveEco: false,
          canManageProducts: false,
        }
      case 'viewer':
        return {
          canCreateEco: false,
          canApproveEco: false,
          canManageProducts: false,
        }
      default:
        return {
          canCreateEco: false,
          canApproveEco: false,
          canManageProducts: false,
        }
    }
  }
}
