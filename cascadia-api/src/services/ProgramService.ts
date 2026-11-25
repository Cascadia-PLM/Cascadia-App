// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  DEFAULT_BRANCH_PROTECTION_SCOPE,
  branchProtectionScopeOf,
  programSettingsSchema,
} from '@cascadia/commons/types/program'
import { db } from '../db'
import {
  PROGRAM_BRANCH_PROTECTION_SCOPE_CHANGED,
  PROGRAM_CREATED,
  publishDomainEvent,
} from '../events'
import { likeContains } from '../db/like-pattern'
import { programMembers, programs, users } from '../db/schema'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../errors'
import { paginatedOrderBy } from '../db/paginated-order'
import type { SQL } from 'drizzle-orm'
import type { BranchProtectionScope } from '@cascadia/commons/types/program'
import type { TransactionClient } from '../db'
import { takeFirst } from '@/db/take-first'
import { clearableDate } from '@/api/wire-date'

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
  startDate: clearableDate().optional(),
  targetEndDate: clearableDate().optional(),
  status: z.enum(['Active', 'On Hold', 'Completed', 'Cancelled']).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  // Strict: only the declared settings keys, merged into what is stored.
  // Changing `branchProtectionScope` is authorized separately — see
  // `ProgramWriteOptions`.
  settings: programSettingsSchema.optional(),
})

export const programUpdateSchema = programCreateSchema.partial()

export type CreateProgramInput = z.infer<typeof programCreateSchema>
export type UpdateProgramInput = z.infer<typeof programUpdateSchema>

/**
 * How a caller vouches for a change to the program's branch-protection scope.
 *
 * The scope decides what a protected main refuses for every design in the
 * program, so changing it is not the ordinary program edit that
 * `programs:update` (or being the program's admin) admits. The route supplies
 * the check it can make — the caller's own grant, API-key scope included —
 * and the service runs it only when the stored value would actually change,
 * inside the transaction that writes it, after locking the row: a check
 * against a value read earlier could be raced by a concurrent edit.
 *
 * With no authorizer a scope change is refused (`PermissionDeniedError` on
 * `system:manage`), so a new caller cannot loosen change control by omission.
 */
export interface ProgramWriteOptions {
  authorizeBranchProtectionScopeChange?: () => Promise<void>
}

export const programRoleSchema = z.enum(['admin', 'lead', 'engineer', 'viewer'])
export type ProgramRole = z.infer<typeof programRoleSchema>

/**
 * Add-member request body. Strict: the columns of program_members not listed
 * here (id, programId, joinedAt, invitedBy, the flag columns) are set by the
 * server, never by the caller.
 */
export const memberAddSchema = z.strictObject({
  userId: z.string().uuid(),
  role: programRoleSchema,
})

/**
 * Update-member request body. Strict so a request body cannot reach columns
 * it must never touch (userId/programId/id/joinedAt would re-point the
 * membership row itself).
 */
export const memberUpdateSchema = z.strictObject({
  role: programRoleSchema.optional(),
  canCreateEco: z.boolean().optional(),
  canApproveEco: z.boolean().optional(),
  canManageDesigns: z.boolean().optional(),
})

export type ProgramMemberUpdate = z.infer<typeof memberUpdateSchema>

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
  static async create(
    data: CreateProgramInput,
    userId: string,
    options?: ProgramWriteOptions,
  ) {
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

    // The program row, the creator's administrator membership and the fact,
    // in one transaction.
    //
    // These were two separate pool writes, so a failed membership insert left
    // an **ownerless program** — and a program is the permission boundary, so
    // nothing in the product could then reach it to fix it. Wrapping them is an
    // independent data-integrity fix that earns its own changelog line; the
    // event is why it happened now rather than eventually.
    return db.transaction(async (tx) => {
      const program = takeFirst(
        await tx
          .insert(programs)
          .values({
            name: validated.name,
            code: validated.code,
            description: validated.description,
            contractNumber: validated.contractNumber,
            customer: validated.customer,
            settings: validated.settings ?? {},
            startDate: validated.startDate,
            targetEndDate: validated.targetEndDate,
            status: validated.status || 'Active',
            attributes: validated.attributes || {},
            createdBy: userId,
            updatedBy: userId,
          })
          .returning(),
      )

      // Automatically add creator as admin
      await tx.insert(programMembers).values({
        programId: program.id,
        userId: userId,
        role: 'admin',
        canCreateEco: true,
        canApproveEco: true,
        canManageDesigns: true,
        invitedBy: userId,
      })

      await publishDomainEvent(tx, PROGRAM_CREATED, {
        actorId: userId,
        subject: { id: program.id },
        context: { programId: program.id },
        payload: {
          programId: program.id,
          name: program.name,
          code: program.code,
          status: program.status,
          customer: program.customer,
          contractNumber: program.contractNumber,
        },
      })

      // Born with a non-default scope: as much a change of change control as
      // switching it later, so it takes the same authority and leaves the same
      // record.
      const scope = branchProtectionScopeOf(program.settings)
      if (scope !== DEFAULT_BRANCH_PROTECTION_SCOPE) {
        await this.recordBranchProtectionScopeChange(
          tx,
          program.id,
          null,
          scope,
          userId,
          options,
        )
      }

      return program
    })
  }

  /**
   * The scope a program's designs are protected under.
   */
  static async getBranchProtectionScope(
    programId: string,
  ): Promise<BranchProtectionScope> {
    const row = await db
      .select({ settings: programs.settings })
      .from(programs)
      .where(eq(programs.id, programId))
      .limit(1)
      .then((rows) => rows.at(0))
    return branchProtectionScopeOf(row?.settings)
  }

  /**
   * Authorize and record a scope change, inside the transaction that writes it.
   */
  private static async recordBranchProtectionScopeChange(
    tx: TransactionClient,
    programId: string,
    previousScope: BranchProtectionScope | null,
    scope: BranchProtectionScope,
    userId: string,
    options: ProgramWriteOptions | undefined,
  ): Promise<void> {
    if (!options?.authorizeBranchProtectionScopeChange) {
      throw new PermissionDeniedError('system', 'manage', {
        operation: 'changeBranchProtectionScope',
      })
    }
    await options.authorizeBranchProtectionScopeChange()

    await publishDomainEvent(tx, PROGRAM_BRANCH_PROTECTION_SCOPE_CHANGED, {
      actorId: userId,
      subject: { id: programId },
      context: { programId },
      payload: {
        programId,
        previousScope,
        scope,
        loosensProtection:
          scope === 'released-items' &&
          (previousScope ?? DEFAULT_BRANCH_PROTECTION_SCOPE) === 'design',
      },
    })
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
  static async update(
    id: string,
    data: UpdateProgramInput,
    userId: string,
    options?: ProgramWriteOptions,
  ) {
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

    const { settings: settingsUpdate, ...fields } = validated

    return db.transaction(async (tx) => {
      // Settings merge key by key into what is stored, so they are read under
      // a row lock: two concurrent edits would otherwise each merge into the
      // same stale blob, and the scope comparison below would be against a
      // value that is no longer the one being replaced.
      const current = await tx
        .select({ settings: programs.settings })
        .from(programs)
        .where(eq(programs.id, id))
        .for('update')
        .then((rows) => rows.at(0))
      if (!current) {
        throw new NotFoundError('Program', id, { operation: 'update' })
      }

      const updated = takeFirst(
        await tx
          .update(programs)
          .set({
            ...fields,
            ...(settingsUpdate !== undefined
              ? { settings: { ...(current.settings ?? {}), ...settingsUpdate } }
              : {}),
            updatedBy: userId,
            updatedAt: new Date(),
          })
          .where(eq(programs.id, id))
          .returning(),
      )

      // No event, and no extra authority, for a write that leaves the scope
      // where it was — including a form that echoes the current value back.
      const previousScope = branchProtectionScopeOf(current.settings)
      const scope = branchProtectionScopeOf(updated.settings)
      if (scope !== previousScope) {
        await this.recordBranchProtectionScopeChange(
          tx,
          id,
          previousScope,
          scope,
          userId,
          options,
        )
      }

      return updated
    })
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
   * List all programs (for cross-program authority)
   */
  static async listAll(filters?: ProgramFilters) {
    const limit = filters?.limit || 50
    const offset = filters?.offset || 0

    const result = filters?.status
      ? await db
          .select()
          .from(programs)
          .where(eq(programs.status, filters.status))
          .orderBy(...paginatedOrderBy(desc(programs.createdAt), programs.id))
          .limit(limit)
          .offset(offset)
      : await db
          .select()
          .from(programs)
          .orderBy(...paginatedOrderBy(desc(programs.createdAt), programs.id))
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
      const searchTerm = likeContains(criteria.globalSearch.trim())
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
      .orderBy(...paginatedOrderBy(orderBy, programs.id))
      .limit(criteria.limit || 50)
      .offset(criteria.offset || 0)

    // Get total count with same conditions
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(programs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)

    return {
      items: results,
      total: countResult!.count,
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
      return ilike(column, likeContains(filterValue.trim()))
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
    const parsedRole = programRoleSchema.safeParse(role)
    if (!parsedRole.success) {
      throw new ValidationError(
        `Invalid program role '${String(role)}'`,
        undefined,
        { field: 'role' },
      )
    }

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

    const member = takeFirst(
      await db
        .insert(programMembers)
        .values({
          programId,
          userId,
          role,
          canCreateEco: permissions.canCreateEco,
          canApproveEco: permissions.canApproveEco,
          canManageDesigns: permissions.canManageDesigns,
          invitedBy,
        })
        .returning(),
    )

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
    // Strict parse: unknown keys (userId, programId, joinedAt, …) are a
    // mass-assignment attempt, not a partial update — reject them.
    const validated = memberUpdateSchema.parse(updates)
    if (Object.keys(validated).length === 0) {
      throw new ValidationError('No member fields to update')
    }

    const existing = await this.getMember(programId, userId)
    if (!existing) {
      throw new NotFoundError('Program member', `${programId}/${userId}`, {
        operation: 'updateMember',
      })
    }

    // A program must always keep at least one admin — demoting the last one
    // would strand it, same as removing them.
    if (
      existing.role === 'admin' &&
      validated.role !== undefined &&
      validated.role !== 'admin'
    ) {
      const adminCount = await this.countAdmins(programId)
      if (adminCount <= 1) {
        throw new ValidationError(
          'Cannot demote the last admin of a program',
          undefined,
          { field: 'role' },
        )
      }
    }

    // A role change re-baselines the flags to the new role's defaults;
    // explicit flags in the same request win over the defaults.
    const changes: ProgramMemberUpdate = { ...validated }
    if (validated.role !== undefined && validated.role !== existing.role) {
      const defaults = this.getDefaultPermissions(validated.role)
      changes.canCreateEco = validated.canCreateEco ?? defaults.canCreateEco
      changes.canApproveEco = validated.canApproveEco ?? defaults.canApproveEco
      changes.canManageDesigns =
        validated.canManageDesigns ?? defaults.canManageDesigns
    }

    const [updated] = await db
      .update(programMembers)
      .set(changes)
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
      const adminCount = await this.countAdmins(programId)
      if (adminCount <= 1) {
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
   * List all members of a program, with the user identity joined in so
   * callers (the Team tab) can render names without N+1 user lookups.
   */
  static async listMembers(programId: string) {
    const program = await this.getById(programId)
    if (!program) {
      throw new NotFoundError('Program', programId, {
        operation: 'listMembers',
      })
    }

    const rows = await db
      .select({
        member: programMembers,
        userName: users.name,
        userEmail: users.email,
      })
      .from(programMembers)
      .innerJoin(users, eq(programMembers.userId, users.id))
      .where(eq(programMembers.programId, programId))
      .orderBy(programMembers.joinedAt)

    return rows.map((r) => ({
      ...r.member,
      user: { id: r.member.userId, name: r.userName, email: r.userEmail },
    }))
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

  private static async countAdmins(programId: string): Promise<number> {
    const admins = await db
      .select({ id: programMembers.id })
      .from(programMembers)
      .where(
        and(
          eq(programMembers.programId, programId),
          eq(programMembers.role, 'admin'),
        ),
      )
    return admins.length
  }

  private static getDefaultPermissions(role: ProgramRole) {
    switch (role) {
      case 'admin':
        return {
          canCreateEco: true,
          canApproveEco: true,
          canManageDesigns: true,
        }
      case 'lead':
        return {
          canCreateEco: true,
          canApproveEco: true,
          canManageDesigns: false,
        }
      case 'engineer':
        return {
          canCreateEco: true,
          canApproveEco: false,
          canManageDesigns: false,
        }
      case 'viewer':
        return {
          canCreateEco: false,
          canApproveEco: false,
          canManageDesigns: false,
        }
      default:
        return {
          canCreateEco: false,
          canApproveEco: false,
          canManageDesigns: false,
        }
    }
  }
}
