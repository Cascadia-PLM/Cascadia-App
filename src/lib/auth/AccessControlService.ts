// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Access Control Service
 *
 * Centralized service for program-based access control (PBAC).
 * Handles Global Admin bypass, program membership checks, and global library access.
 */

import { ProgramService } from '../services/ProgramService'
import { DesignService } from '../services/DesignService'
import { permissionService } from './permission-service'
import type { RoleName } from './permissions'

/**
 * Global Admin role name - users with this role bypass all program-based access checks
 */
export const GLOBAL_ADMIN_ROLE: RoleName = 'Global Admin'

export class AccessControlService {
  /**
   * Check if user is a Global Admin (bypasses all program checks)
   */
  static async isGlobalAdmin(userId: string): Promise<boolean> {
    return permissionService.hasRole(userId, GLOBAL_ADMIN_ROLE)
  }

  /**
   * Check if user can access a program's data
   */
  static async canAccessProgram(
    userId: string,
    programId: string,
  ): Promise<boolean> {
    // Global Admin bypasses all checks
    if (await this.isGlobalAdmin(userId)) {
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
    // Global Admin bypasses all checks
    if (await this.isGlobalAdmin(userId)) {
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
    // Global Admin sees all programs
    if (await this.isGlobalAdmin(userId)) {
      return ProgramService.listAll()
    }

    return ProgramService.listByUser(userId)
  }

  /**
   * Get all designs a user can access
   */
  static async getAccessibleDesigns(userId: string) {
    // Global Admin sees all designs
    if (await this.isGlobalAdmin(userId)) {
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
   * Get all program IDs a user can access (for filtering queries)
   * Returns null for Global Admin (meaning "all programs")
   */
  static async getAccessibleProgramIds(
    userId: string,
  ): Promise<Array<string> | null> {
    // Global Admin - return null to indicate "all"
    if (await this.isGlobalAdmin(userId)) {
      return null
    }

    const programs = await ProgramService.listByUser(userId)
    return programs.map((p) => p.id)
  }
}
