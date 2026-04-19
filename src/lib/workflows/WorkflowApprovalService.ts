import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db'
import {
  workflowApprovalVotes,
  workflowDefinitions,
  workflowInstances,
  workflowStateApprovers,
} from '../db/schema/workflows'
import { roles, userRoles, users } from '../db/schema/users'
import type {
  ApprovalCompletionStatus,
  ApprovalStatus,
  ApprovalsByState,
  ApproverInput,
  ApproverWithStatus,
  CanApproveResult,
  StateApprover,
  WorkflowState,
} from './types'

/**
 * Service for managing workflow approvals
 *
 * Handles two levels of approval management:
 * 1. Definition-level: Which users/roles are approvers for each workflow state
 * 2. Instance-level: Tracking actual approval votes for workflow instances
 */
export class WorkflowApprovalService {
  // ============================================
  // Definition-level Approver Management
  // ============================================

  /**
   * Get all approvers for a specific state in a workflow definition
   */
  static async getStateApprovers(
    definitionId: string,
    stateId: string,
  ): Promise<Array<StateApprover>> {
    const approvers = await db
      .select()
      .from(workflowStateApprovers)
      .where(
        and(
          eq(workflowStateApprovers.workflowDefinitionId, definitionId),
          eq(workflowStateApprovers.stateId, stateId),
        ),
      )

    // Resolve approver names
    return Promise.all(
      approvers.map(async (approver) => ({
        id: approver.id,
        workflowDefinitionId: approver.workflowDefinitionId,
        stateId: approver.stateId,
        approverType: approver.approverType as 'user' | 'role',
        approverId: approver.approverId,
        approverName: await this.resolveApproverName(
          approver.approverType as 'user' | 'role',
          approver.approverId,
        ),
        isRequired: approver.isRequired,
        createdAt: approver.createdAt,
      })),
    )
  }

  /**
   * Get all approvers for all states in a workflow definition
   * Returns a map of stateId -> approvers
   */
  static async getAllStateApprovers(
    definitionId: string,
  ): Promise<Record<string, Array<StateApprover>>> {
    const approvers = await db
      .select()
      .from(workflowStateApprovers)
      .where(eq(workflowStateApprovers.workflowDefinitionId, definitionId))

    // Group by state and resolve names
    const grouped: Record<string, Array<StateApprover>> = {}

    for (const approver of approvers) {
      if (!grouped[approver.stateId]) {
        grouped[approver.stateId] = []
      }

      grouped[approver.stateId].push({
        id: approver.id,
        workflowDefinitionId: approver.workflowDefinitionId,
        stateId: approver.stateId,
        approverType: approver.approverType as 'user' | 'role',
        approverId: approver.approverId,
        approverName: await this.resolveApproverName(
          approver.approverType as 'user' | 'role',
          approver.approverId,
        ),
        isRequired: approver.isRequired,
        createdAt: approver.createdAt,
      })
    }

    return grouped
  }

  /**
   * Set approvers for a state (replaces existing)
   */
  static async setStateApprovers(
    definitionId: string,
    stateId: string,
    approvers: Array<ApproverInput>,
    userId: string,
  ): Promise<Array<StateApprover>> {
    // Delete existing approvers for this state
    await db
      .delete(workflowStateApprovers)
      .where(
        and(
          eq(workflowStateApprovers.workflowDefinitionId, definitionId),
          eq(workflowStateApprovers.stateId, stateId),
        ),
      )

    if (approvers.length === 0) {
      return []
    }

    // Insert new approvers
    const inserted = await db
      .insert(workflowStateApprovers)
      .values(
        approvers.map((a) => ({
          workflowDefinitionId: definitionId,
          stateId,
          approverType: a.type,
          approverId: a.id,
          isRequired: a.isRequired,
          createdBy: userId,
        })),
      )
      .returning()

    // Return with resolved names
    return Promise.all(
      inserted.map(async (approver) => ({
        id: approver.id,
        workflowDefinitionId: approver.workflowDefinitionId,
        stateId: approver.stateId,
        approverType: approver.approverType as 'user' | 'role',
        approverId: approver.approverId,
        approverName: await this.resolveApproverName(
          approver.approverType as 'user' | 'role',
          approver.approverId,
        ),
        isRequired: approver.isRequired,
        createdAt: approver.createdAt,
      })),
    )
  }

  /**
   * Add a single approver to a state
   */
  static async addStateApprover(
    definitionId: string,
    stateId: string,
    approver: ApproverInput,
    userId: string,
  ): Promise<StateApprover> {
    // Check if approver already exists for this state
    const existing = await db
      .select()
      .from(workflowStateApprovers)
      .where(
        and(
          eq(workflowStateApprovers.workflowDefinitionId, definitionId),
          eq(workflowStateApprovers.stateId, stateId),
          eq(workflowStateApprovers.approverType, approver.type),
          eq(workflowStateApprovers.approverId, approver.id),
        ),
      )
      .limit(1)

    if (existing.length > 0) {
      throw new Error('Approver already exists for this state')
    }

    const [inserted] = await db
      .insert(workflowStateApprovers)
      .values({
        workflowDefinitionId: definitionId,
        stateId,
        approverType: approver.type,
        approverId: approver.id,
        isRequired: approver.isRequired,
        createdBy: userId,
      })
      .returning()

    return {
      id: inserted.id,
      workflowDefinitionId: inserted.workflowDefinitionId,
      stateId: inserted.stateId,
      approverType: inserted.approverType as 'user' | 'role',
      approverId: inserted.approverId,
      approverName: await this.resolveApproverName(
        inserted.approverType as 'user' | 'role',
        inserted.approverId,
      ),
      isRequired: inserted.isRequired,
      createdAt: inserted.createdAt,
    }
  }

  /**
   * Remove an approver
   */
  static async removeStateApprover(approverId: string): Promise<void> {
    await db
      .delete(workflowStateApprovers)
      .where(eq(workflowStateApprovers.id, approverId))
  }

  /**
   * Update an approver's required status
   */
  static async updateStateApprover(
    approverId: string,
    isRequired: boolean,
  ): Promise<StateApprover> {
    const [updated] = await db
      .update(workflowStateApprovers)
      .set({ isRequired })
      .where(eq(workflowStateApprovers.id, approverId))
      .returning()

    if (!updated) {
      throw new Error('Approver not found')
    }

    return {
      id: updated.id,
      workflowDefinitionId: updated.workflowDefinitionId,
      stateId: updated.stateId,
      approverType: updated.approverType as 'user' | 'role',
      approverId: updated.approverId,
      approverName: await this.resolveApproverName(
        updated.approverType as 'user' | 'role',
        updated.approverId,
      ),
      isRequired: updated.isRequired,
      createdAt: updated.createdAt,
    }
  }

  // ============================================
  // Instance-level Approval Tracking
  // ============================================

  /**
   * Get approval status for all states in a workflow instance
   */
  static async getApprovals(instanceId: string): Promise<ApprovalsByState> {
    // Get the workflow instance and definition
    const instance = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId))
      .limit(1)

    if (instance.length === 0) {
      throw new Error('Workflow instance not found')
    }

    const definitionId = instance[0].workflowDefinitionId
    if (!definitionId) {
      throw new Error('Workflow instance has no definition')
    }

    // Get the workflow definition to get states
    const definition = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, definitionId))
      .limit(1)

    if (definition.length === 0) {
      throw new Error('Workflow definition not found')
    }

    const states = (
      definition[0].definition as { states: Array<WorkflowState> }
    ).states

    // Get all approvers for this definition
    const allApprovers = await this.getAllStateApprovers(definitionId)

    // Get all votes for this instance
    const votes = await db
      .select()
      .from(workflowApprovalVotes)
      .where(eq(workflowApprovalVotes.workflowInstanceId, instanceId))

    // Build approval status for each state
    const result: ApprovalsByState = {}

    for (const state of states) {
      const stateApprovers = allApprovers[state.id] || []
      const stateVotes = votes.filter((v) => v.stateId === state.id)

      result[state.id] = await this.buildApprovalStatus(
        state,
        stateApprovers,
        stateVotes,
      )
    }

    return result
  }

  /**
   * Get approval status for a specific state
   */
  static async getStateApprovals(
    instanceId: string,
    stateId: string,
  ): Promise<ApprovalStatus> {
    // Get the workflow instance
    const instance = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId))
      .limit(1)

    if (instance.length === 0) {
      throw new Error('Workflow instance not found')
    }

    const definitionId = instance[0].workflowDefinitionId
    if (!definitionId) {
      throw new Error('Workflow instance has no definition')
    }

    // Get the workflow definition to get state name
    const definition = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, definitionId))
      .limit(1)

    if (definition.length === 0) {
      throw new Error('Workflow definition not found')
    }

    const states = (
      definition[0].definition as { states: Array<WorkflowState> }
    ).states
    const state = states.find((s) => s.id === stateId)

    if (!state) {
      throw new Error('State not found in workflow definition')
    }

    // Get approvers for this state
    const stateApprovers = await this.getStateApprovers(definitionId, stateId)

    // Get votes for this state
    const votes = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
        ),
      )

    return this.buildApprovalStatus(state, stateApprovers, votes)
  }

  /**
   * Submit an approval vote
   */
  static async submitApproval(
    instanceId: string,
    stateId: string,
    userId: string,
    vote: 'approved' | 'rejected',
    roleId?: string,
    comments?: string,
  ): Promise<{ id: string; vote: string; votedAt: Date }> {
    // Verify the user can approve
    const canApprove = await this.canUserApprove(instanceId, stateId, userId)

    // Check alreadyVoted first to provide a more specific error message
    if (canApprove.alreadyVoted) {
      throw new Error('User has already voted for this state')
    }

    if (!canApprove.canApprove) {
      throw new Error('User is not authorized to approve at this state')
    }

    // If approving as a role, verify the role is valid
    if (roleId) {
      const validRole = canApprove.asRoles.find((r) => r.id === roleId)
      if (!validRole) {
        throw new Error('User cannot approve as this role')
      }
    }

    // Check if already voted (prevent race conditions)
    const existingVote = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
          eq(workflowApprovalVotes.userId, userId),
        ),
      )
      .limit(1)

    if (existingVote.length > 0) {
      throw new Error('Vote already submitted')
    }

    // Insert the vote
    const [inserted] = await db
      .insert(workflowApprovalVotes)
      .values({
        workflowInstanceId: instanceId,
        stateId,
        userId,
        roleId: roleId || null,
        vote,
        comments: comments || null,
      })
      .returning()

    return {
      id: inserted.id,
      vote: inserted.vote,
      votedAt: inserted.votedAt,
    }
  }

  /**
   * Check if a user can approve at a specific state
   */
  static async canUserApprove(
    instanceId: string,
    stateId: string,
    userId: string,
  ): Promise<CanApproveResult> {
    // Get the workflow instance
    const instance = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId))
      .limit(1)

    if (instance.length === 0) {
      return {
        canApprove: false,
        asUser: false,
        asRoles: [],
        alreadyVoted: false,
      }
    }

    const definitionId = instance[0].workflowDefinitionId
    if (!definitionId) {
      return {
        canApprove: false,
        asUser: false,
        asRoles: [],
        alreadyVoted: false,
      }
    }

    // Get approvers for this state
    const stateApprovers = await this.getStateApprovers(definitionId, stateId)

    if (stateApprovers.length === 0) {
      // No approvers defined - anyone can approve
      return {
        canApprove: true,
        asUser: true,
        asRoles: [],
        alreadyVoted: false,
      }
    }

    // Check if user has already voted
    const existingVote = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
          eq(workflowApprovalVotes.userId, userId),
        ),
      )
      .limit(1)

    const alreadyVoted = existingVote.length > 0

    // Check if user is a direct approver
    const isDirectApprover = stateApprovers.some(
      (a) => a.approverType === 'user' && a.approverId === userId,
    )

    // Get user's roles
    const userRoleRecords = await db
      .select({ roleId: userRoles.roleId, roleName: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))

    // Check which role approvers the user can fulfill
    const approverRoles = stateApprovers.filter(
      (a) => a.approverType === 'role',
    )
    const matchingRoles = userRoleRecords
      .filter((ur) => approverRoles.some((ar) => ar.approverId === ur.roleId))
      .map((ur) => ({ id: ur.roleId, name: ur.roleName }))

    const canApprove =
      !alreadyVoted && (isDirectApprover || matchingRoles.length > 0)

    return {
      canApprove,
      asUser: isDirectApprover,
      asRoles: matchingRoles,
      alreadyVoted,
      existingVote: alreadyVoted
        ? (existingVote[0].vote as 'approved' | 'rejected')
        : undefined,
    }
  }

  /**
   * Check if all required approvals are complete for a state
   * Used for transition gating
   */
  static async areApprovalsComplete(
    instanceId: string,
    stateId: string,
  ): Promise<ApprovalCompletionStatus> {
    // Get the workflow instance
    const instance = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId))
      .limit(1)

    if (instance.length === 0) {
      return { met: false, required: 0, current: 0, pending: [] }
    }

    const definitionId = instance[0].workflowDefinitionId
    if (!definitionId) {
      return { met: true, required: 0, current: 0, pending: [] }
    }

    // Get approvers for this state
    const stateApprovers = await this.getStateApprovers(definitionId, stateId)
    const requiredApprovers = stateApprovers.filter((a) => a.isRequired)

    if (requiredApprovers.length === 0) {
      // No required approvers - approval requirement is met
      return { met: true, required: 0, current: 0, pending: [] }
    }

    // Get votes for this state
    const votes = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
          eq(workflowApprovalVotes.vote, 'approved'),
        ),
      )

    // Check which required approvers have approved
    const pending: Array<{ type: 'user' | 'role'; id: string; name: string }> =
      []
    let approvedCount = 0

    for (const approver of requiredApprovers) {
      let isApproved = false

      if (approver.approverType === 'user') {
        // Direct user approval
        isApproved = votes.some((v) => v.userId === approver.approverId)
      } else {
        // Role approval - check if any user approved with this role
        isApproved = votes.some((v) => v.roleId === approver.approverId)
      }

      if (isApproved) {
        approvedCount++
      } else {
        pending.push({
          type: approver.approverType,
          id: approver.approverId,
          name: approver.approverName || 'Unknown',
        })
      }
    }

    return {
      met: pending.length === 0,
      required: requiredApprovers.length,
      current: approvedCount,
      pending,
    }
  }

  /**
   * Clear all approvals for a state (used when workflow moves backward)
   */
  static async clearStateApprovals(
    instanceId: string,
    stateId: string,
  ): Promise<void> {
    await db
      .delete(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
        ),
      )
  }

  /**
   * Clear all approvals for states after a given state
   * Used when workflow transitions backward
   */
  static async clearApprovalsAfterState(
    instanceId: string,
    stateIds: Array<string>,
  ): Promise<void> {
    if (stateIds.length === 0) return

    await db
      .delete(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          inArray(workflowApprovalVotes.stateId, stateIds),
        ),
      )
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Resolve the name of an approver (user or role)
   */
  private static async resolveApproverName(
    type: 'user' | 'role',
    id: string,
  ): Promise<string> {
    if (type === 'user') {
      const user = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, id))
        .limit(1)

      return user.length > 0 ? user[0].name || user[0].email : 'Unknown User'
    } else {
      const role = await db
        .select({ name: roles.name })
        .from(roles)
        .where(eq(roles.id, id))
        .limit(1)

      return role.length > 0 ? role[0].name : 'Unknown Role'
    }
  }

  /**
   * Build approval status for a state
   */
  private static async buildApprovalStatus(
    state: WorkflowState,
    approvers: Array<StateApprover>,
    votes: Array<{
      id: string
      userId: string
      roleId: string | null
      vote: string
      comments: string | null
      votedAt: Date
    }>,
  ): Promise<ApprovalStatus> {
    const requiredApprovers: Array<ApproverWithStatus> = []
    const optionalApprovers: Array<ApproverWithStatus> = []

    for (const approver of approvers) {
      // Find matching vote
      let matchingVote = null

      if (approver.approverType === 'user') {
        matchingVote = votes.find((v) => v.userId === approver.approverId)
      } else {
        // For role approvers, find any vote with this roleId
        matchingVote = votes.find((v) => v.roleId === approver.approverId)
      }

      // Get voter info if there's a vote
      let votedBy: { id: string; name: string } | undefined
      if (matchingVote) {
        const voterName = await this.resolveApproverName(
          'user',
          matchingVote.userId,
        )
        votedBy = { id: matchingVote.userId, name: voterName }
      }

      const approverWithStatus: ApproverWithStatus = {
        approverType: approver.approverType,
        approverId: approver.approverId,
        approverName: approver.approverName || 'Unknown',
        isRequired: approver.isRequired,
        vote: matchingVote
          ? (matchingVote.vote as 'approved' | 'rejected')
          : null,
        votedBy,
        votedAt: matchingVote?.votedAt,
        comments: matchingVote?.comments || undefined,
      }

      if (approver.isRequired) {
        requiredApprovers.push(approverWithStatus)
      } else {
        optionalApprovers.push(approverWithStatus)
      }
    }

    // Calculate completion status
    const approvedRequired = requiredApprovers.filter(
      (a) => a.vote === 'approved',
    ).length
    const isComplete =
      requiredApprovers.length === 0 ||
      approvedRequired === requiredApprovers.length

    return {
      stateId: state.id,
      stateName: state.name,
      requiredApprovers,
      optionalApprovers,
      isComplete,
      approvedCount: approvedRequired,
      requiredCount: requiredApprovers.length,
    }
  }
}
