// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Access Control Service
 *
 * Centralized service for program-based access control (PBAC).
 * Handles the cross-program bypass, program membership checks, and global
 * library access.
 */

import { ProgramService } from '../services/ProgramService'
import { DesignService } from '../services/DesignService'
import { permissionService } from './permission-service'
import type { AccessScope } from '../db/filters'

export class AccessControlService {
  /**
   * Whether the user carries cross-program authority — the bypass for every
   * program-membership check.
   *
   * Keyed on the RBAC `programs:manage` permission, not a role name. The
   * built-in Administrator role holds it; a deployment can craft custom
   * roles with or without it to grant or withhold the bypass. (This
   * replaced a check for the literal role name 'Global Admin', a leftover
   * from an early multi-tenant design. Deployments seeded with that role
   * keep working unchanged: its stored permissions include programs:manage,
   * so the permission check matches the same users the name check did.)
   */
  static async hasCrossProgramAccess(userId: string): Promise<boolean> {
    return permissionService.canUser(userId, 'manage', 'programs')
  }

  /**
   * Check if user can access a program's data
   */
  static async canAccessProgram(
    userId: string,
    programId: string,
  ): Promise<boolean> {
    // Cross-program authority bypasses all checks
    if (await this.hasCrossProgramAccess(userId)) {
      return true
    }

    return ProgramService.canUserAccess(userId, programId)
  }

  /**
   * Check if user can access a design
   * - Global libraries (programId = null, designType = 'Library') are accessible to all authenticated users
   * - Other designs require program membership
   */
  static async canAccessDesign(
    userId: string,
    designId: string,
  ): Promise<boolean> {
    // Cross-program authority bypasses all checks
    if (await this.hasCrossProgramAccess(userId)) {
      return true
    }

    const design = await DesignService.getById(designId)
    if (!design) return false

    // Global libraries are accessible to all authenticated users
    if (design.programId === null && design.designType === 'Library') {
      return true
    }

    // Designs without programId (unassigned) are accessible to all authenticated users
    // This allows newly created designs to be visible before being assigned to a program
    if (design.programId === null) {
      return true
    }

    // Otherwise, check program membership
    return this.canAccessProgram(userId, design.programId)
  }

  /**
   * Get all programs a user can access
   */
  static async getAccessiblePrograms(userId: string) {
    // Cross-program authority sees all programs
    if (await this.hasCrossProgramAccess(userId)) {
      return ProgramService.listAll()
    }

    return ProgramService.listByUser(userId)
  }

  /**
   * Get all designs a user can access
   */
  static async getAccessibleDesigns(userId: string) {
    // Cross-program authority sees all designs
    if (await this.hasCrossProgramAccess(userId)) {
      return DesignService.listAll()
    }

    // Get user's programs
    const programs = await ProgramService.listByUser(userId)
    const programIds = programs.map((p) => p.id)

    // Get designs from user's programs + global libraries + unassigned designs
    const [programDesigns, globalLibraries, unassignedDesigns] =
      await Promise.all([
        programIds.length > 0
          ? DesignService.listByProgramIds(programIds)
          : Promise.resolve([]),
        DesignService.listGlobalLibraries(),
        DesignService.listUnassigned(),
      ])

    return [...programDesigns, ...globalLibraries, ...unassignedDesigns]
  }

  /**
   * Every design id the user may read, or `null` for "all designs".
   *
   * The scope counterpart to `canAccessDesign`: that answers the question for
   * one design, this answers it for a list query in one round trip. Both admit
   * the same set, so a row surviving this filter would also survive a per-id
   * check.
   *
   * `null` means unrestricted, matching `getAccessibleProgramIds`. It is not
   * the same as `[]`, which means the user reaches no design at all — a list
   * given `[]` must return nothing, never everything.
   */
  static async getAccessibleDesignIds(
    userId: string,
  ): Promise<Array<string> | null> {
    // Cross-program authority - return null to indicate "all"
    if (await this.hasCrossProgramAccess(userId)) {
      return null
    }

    const programs = await ProgramService.listByUser(userId)
    return DesignService.listAccessibleIds(programs.map((p) => p.id))
  }

  /**
   * Get all program IDs a user can access (for filtering queries)
   * Returns null for cross-program authority (meaning "all programs")
   */
  static async getAccessibleProgramIds(
    userId: string,
  ): Promise<Array<string> | null> {
    // Cross-program authority - return null to indicate "all"
    if (await this.hasCrossProgramAccess(userId)) {
      return null
    }

    const programs = await ProgramService.listByUser(userId)
    return programs.map((p) => p.id)
  }

  /**
   * Both axes of the caller's reach, resolved together — what
   * `accessScopeCondition` takes.
   *
   * Not every item type scopes on designs: a work order names its program on
   * its own row and has no design at all, and neither axis derives from the
   * other. Resolving them here rather than at each call site means a query
   * cannot end up bounded on one axis and unbounded on the other, and it
   * costs one membership lookup instead of the two that
   * `getAccessibleDesignIds` + `getAccessibleProgramIds` made side by side.
   *
   * `null` is cross-program authority. It is not `{ designIds: [],
   * programIds: [] }`, which reaches nothing on either axis.
   */
  static async getAccessScope(userId: string): Promise<AccessScope | null> {
    // Cross-program authority - return null to indicate "all"
    if (await this.hasCrossProgramAccess(userId)) {
      return null
    }

    const programs = await ProgramService.listByUser(userId)
    const programIds = programs.map((p) => p.id)
    return {
      programIds,
      designIds: await DesignService.listAccessibleIds(programIds),
    }
  }
}
