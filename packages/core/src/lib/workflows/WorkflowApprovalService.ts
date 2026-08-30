// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import {
  workflowApprovalVotes,
  workflowDefinitions,
  workflowInstanceApprovers,
  workflowInstances,
  workflowStateApprovers,
} from '../db/schema/workflows'
import { roles, userRoles, users } from '../db/schema/users'
import { items } from '../db/schema/items'
import { ApprovalRegistry } from './approval-registry'
import type {
  ApprovalCompletionStatus,
  ApprovalStatus,
  ApprovalsByState,
  ApproverInput,
  ApproverWithStatus,
  CanApproveResult,
  InstanceApprover,
  StateApprover,
  WorkflowState,
} from './types'
import type {
  ApprovalAttestation,
  ApprovalContext,
  ApprovalExtras,
  ApprovalResultExtras,
} from './approval-registry'
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { isUniqueViolation } from '@/lib/errors/pg'
import { takeFirst } from '@/lib/db/take-first'

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

    // Resolve approver names in bulk
    const names = await this.resolveApproverNames(
      approvers.map((a) => ({
        type: a.approverType as 'user' | 'role',
        id: a.approverId,
      })),
    )
    return approvers.map((approver) => ({
      id: approver.id,
      workflowDefinitionId: approver.workflowDefinitionId,
      stateId: approver.stateId,
      approverType: approver.approverType as 'user' | 'role',
      approverId: approver.approverId,
      approverName: this.approverNameFrom(
        names,
        approver.approverType as 'user' | 'role',
        approver.approverId,
      ),
      isRequired: approver.isRequired,
      createdAt: approver.createdAt,
    }))
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

    // Group by state, names resolved in bulk
    const names = await this.resolveApproverNames(
      approvers.map((a) => ({
        type: a.approverType as 'user' | 'role',
        id: a.approverId,
      })),
    )
    const grouped: Record<string, Array<StateApprover>> = {}

    for (const approver of approvers) {
      const bucket = (grouped[approver.stateId] ??= [])

      bucket.push({
        id: approver.id,
        workflowDefinitionId: approver.workflowDefinitionId,
        stateId: approver.stateId,
        approverType: approver.approverType as 'user' | 'role',
        approverId: approver.approverId,
        approverName: this.approverNameFrom(
          names,
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

    // Insert new approvers. Same reason as `setInstanceApprovers` below: the
    // replacement delete has already run, so a repeated pair inside the
    // caller's array would abort the write under `uq_wf_state_approvers` and
    // leave the state with no approvers at all — a wide-open gate, from a
    // request whose meaning was never in doubt. `.returning()` then reports
    // the rows that actually landed, which is the deduped set.
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
      .onConflictDoNothing()
      .returning()

    // Return with names resolved in bulk
    const names = await this.resolveApproverNames(
      inserted.map((a) => ({
        type: a.approverType as 'user' | 'role',
        id: a.approverId,
      })),
    )
    return inserted.map((approver) => ({
      id: approver.id,
      workflowDefinitionId: approver.workflowDefinitionId,
      stateId: approver.stateId,
      approverType: approver.approverType as 'user' | 'role',
      approverId: approver.approverId,
      approverName: this.approverNameFrom(
        names,
        approver.approverType as 'user' | 'role',
        approver.approverId,
      ),
      isRequired: approver.isRequired,
      createdAt: approver.createdAt,
    }))
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
      throw new ConflictError('Approver already exists for this state')
    }

    let inserted
    try {
      inserted = takeFirst(
        await db
          .insert(workflowStateApprovers)
          .values({
            workflowDefinitionId: definitionId,
            stateId,
            approverType: approver.type,
            approverId: approver.id,
            isRequired: approver.isRequired,
            createdBy: userId,
          })
          .returning(),
      )
    } catch (error) {
      // The loser of the race the pre-check above cannot close. Same error the
      // pre-check raises, so the caller sees 409 rather than a 500 that reads
      // like a malfunction — the outcome it describes is true either way, the
      // approver is on the state.
      if (isUniqueViolation(error, { table: 'workflow_state_approvers' })) {
        throw new ConflictError('Approver already exists for this state')
      }
      throw error
    }

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
      throw new NotFoundError('Approver', approverId)
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
  // Instance-level Approver Management (WI-4.2)
  // ============================================

  /**
   * Get instance-level approvers for one state of a workflow instance
   */
  static async getInstanceApprovers(
    instanceId: string,
    stateId: string,
  ): Promise<Array<InstanceApprover>> {
    const approvers = await db
      .select()
      .from(workflowInstanceApprovers)
      .where(
        and(
          eq(workflowInstanceApprovers.workflowInstanceId, instanceId),
          eq(workflowInstanceApprovers.stateId, stateId),
        ),
      )

    const names = await this.resolveApproverNames(
      approvers.map((a) => ({
        type: a.approverType as 'user' | 'role',
        id: a.approverId,
      })),
    )
    return approvers.map((approver) => ({
      id: approver.id,
      workflowInstanceId: approver.workflowInstanceId,
      stateId: approver.stateId,
      approverType: approver.approverType as 'user' | 'role',
      approverId: approver.approverId,
      approverName: this.approverNameFrom(
        names,
        approver.approverType as 'user' | 'role',
        approver.approverId,
      ),
      isRequired: approver.isRequired,
      createdAt: approver.createdAt,
    }))
  }

  /**
   * Get all instance-level approvers for a workflow instance, grouped by
   * state ID
   */
  static async getAllInstanceApprovers(
    instanceId: string,
  ): Promise<Record<string, Array<InstanceApprover>>> {
    const approvers = await db
      .select()
      .from(workflowInstanceApprovers)
      .where(eq(workflowInstanceApprovers.workflowInstanceId, instanceId))

    const names = await this.resolveApproverNames(
      approvers.map((a) => ({
        type: a.approverType as 'user' | 'role',
        id: a.approverId,
      })),
    )
    const grouped: Record<string, Array<InstanceApprover>> = {}
    for (const approver of approvers) {
      const bucket = (grouped[approver.stateId] ??= [])
      bucket.push({
        id: approver.id,
        workflowInstanceId: approver.workflowInstanceId,
        stateId: approver.stateId,
        approverType: approver.approverType as 'user' | 'role',
        approverId: approver.approverId,
        approverName: this.approverNameFrom(
          names,
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
   * Set instance-level approvers for a state (replaces existing)
   */
  static async setInstanceApprovers(
    instanceId: string,
    stateId: string,
    approvers: Array<ApproverInput>,
    userId: string,
  ): Promise<Array<InstanceApprover>> {
    await db
      .delete(workflowInstanceApprovers)
      .where(
        and(
          eq(workflowInstanceApprovers.workflowInstanceId, instanceId),
          eq(workflowInstanceApprovers.stateId, stateId),
        ),
      )

    if (approvers.length === 0) {
      return []
    }

    await db
      .insert(workflowInstanceApprovers)
      .values(
        approvers.map((a) => ({
          workflowInstanceId: instanceId,
          stateId,
          approverType: a.type,
          approverId: a.id,
          isRequired: a.isRequired,
          createdBy: userId,
        })),
      )
      // The caller hands over a whole approver list, and a list naming the
      // same person twice is a redundant request, not an invalid one — under
      // `uq_wf_instance_approvers` it would otherwise abort the write outright
      // and leave the state with no approvers, because the delete above
      // already ran. Skipping the repeat is the same set this method
      // documented before the constraint existed, minus the duplicate row.
      .onConflictDoNothing()

    return this.getInstanceApprovers(instanceId, stateId)
  }

  /**
   * The approvers that actually gate a state on an instance: the union of
   * definition-level approvers (keyed by the definition) and
   * instance-level approvers (covering custom states on flexible
   * instances). Duplicate (type, id) pairs collapse; required wins.
   */
  private static async getEffectiveApprovers(
    definitionId: string | null,
    instanceId: string,
    stateId: string,
  ): Promise<
    Array<{
      approverType: 'user' | 'role'
      approverId: string
      approverName?: string
      isRequired: boolean
    }>
  > {
    const definitionApprovers = definitionId
      ? await this.getStateApprovers(definitionId, stateId)
      : []
    const instanceApprovers = await this.getInstanceApprovers(
      instanceId,
      stateId,
    )

    return this.mergeApproverLists(definitionApprovers, instanceApprovers)
  }

  /**
   * Merge definition- and instance-level approver lists: duplicate
   * (type, id) pairs collapse into one entry; required wins.
   */
  private static mergeApproverLists(
    ...lists: Array<
      Array<{
        approverType: 'user' | 'role'
        approverId: string
        approverName?: string
        isRequired: boolean
      }>
    >
  ): Array<{
    approverType: 'user' | 'role'
    approverId: string
    approverName?: string
    isRequired: boolean
  }> {
    const merged = new Map<
      string,
      {
        approverType: 'user' | 'role'
        approverId: string
        approverName?: string
        isRequired: boolean
      }
    >()
    for (const approver of lists.flat()) {
      const key = `${approver.approverType}:${approver.approverId}`
      const existing = merged.get(key)
      if (existing) {
        existing.isRequired = existing.isRequired || approver.isRequired
      } else {
        merged.set(key, {
          approverType: approver.approverType,
          approverId: approver.approverId,
          approverName: approver.approverName,
          isRequired: approver.isRequired,
        })
      }
    }

    return [...merged.values()]
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

    const instanceRow = instance[0]
    if (!instanceRow) {
      throw new NotFoundError('Workflow instance', instanceId)
    }

    const definitionId = instanceRow.workflowDefinitionId
    if (!definitionId) {
      throw new ValidationError('Workflow instance has no definition')
    }

    // Get the workflow definition to get states
    const definition = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, definitionId))
      .limit(1)

    const definitionRow = definition[0]
    if (!definitionRow) {
      throw new NotFoundError('Workflow definition')
    }

    // Effective states: flexible instances carry their own copied (and
    // possibly extended) structure — custom states must appear here too
    const states =
      (instanceRow.instanceStates as Array<WorkflowState> | null) ??
      (definitionRow.definition as { states: Array<WorkflowState> }).states

    // Approvers from both levels: definition-keyed and instance-keyed
    const definitionApprovers = await this.getAllStateApprovers(definitionId)
    const instanceApprovers = await this.getAllInstanceApprovers(instanceId)

    // Get all active votes for this instance (superseded votes stay in the
    // table for the audit trail but no longer count toward anything)
    const votes = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          isNull(workflowApprovalVotes.supersededAt),
        ),
      )

    // Voter display names for every vote, resolved in one pass
    const voterNames = await this.resolveApproverNames(
      votes.map((v) => ({ type: 'user' as const, id: v.userId })),
    )

    // Build approval status for each state
    const result: ApprovalsByState = {}

    for (const state of states) {
      const stateApprovers = this.mergeApproverLists(
        definitionApprovers[state.id] ?? [],
        instanceApprovers[state.id] ?? [],
      )
      const stateVotes = votes.filter((v) => v.stateId === state.id)

      result[state.id] = this.buildApprovalStatus(
        state,
        stateApprovers,
        stateVotes,
        voterNames,
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

    const instanceRow = instance[0]
    if (!instanceRow) {
      throw new NotFoundError('Workflow instance', instanceId)
    }

    const definitionId = instanceRow.workflowDefinitionId
    if (!definitionId) {
      throw new ValidationError('Workflow instance has no definition')
    }

    // Get the workflow definition to get state name
    const definition = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, definitionId))
      .limit(1)

    const definitionRow = definition[0]
    if (!definitionRow) {
      throw new NotFoundError('Workflow definition')
    }

    // Effective states: instance-level structure wins on flexible instances
    const states =
      (instanceRow.instanceStates as Array<WorkflowState> | null) ??
      (definitionRow.definition as { states: Array<WorkflowState> }).states
    const state = states.find((s) => s.id === stateId)

    if (!state) {
      throw new NotFoundError('State', stateId)
    }

    // Approvers from both levels gate this state
    const stateApprovers = await this.getEffectiveApprovers(
      definitionId,
      instanceId,
      stateId,
    )

    // Get active votes for this state
    const votes = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
          isNull(workflowApprovalVotes.supersededAt),
        ),
      )

    const voterNames = await this.resolveApproverNames(
      votes.map((v) => ({ type: 'user' as const, id: v.userId })),
    )
    return this.buildApprovalStatus(state, stateApprovers, votes, voterNames)
  }

  /**
   * Submit an approval vote.
   *
   * Core owns the vote: the permission checks, the duplicate guard, the insert,
   * and the transaction around it. Modules registered on
   * {@link ApprovalRegistry} may block a vote before it is written and write
   * their own rows in the same transaction once it is — which is how an
   * approval and whatever authorizes it commit or roll back together.
   */
  static async submitApproval(
    instanceId: string,
    stateId: string,
    userId: string,
    vote: 'approved' | 'rejected',
    roleId?: string,
    comments?: string,
    extras: ApprovalExtras = {},
  ): Promise<
    {
      id: string
      vote: string
      votedAt: Date
    } & ApprovalResultExtras
  > {
    // Verify the user can approve
    const canApprove = await this.canUserApprove(instanceId, stateId, userId)

    // Check alreadyVoted first to provide a more specific error message
    if (canApprove.alreadyVoted) {
      throw new ConflictError('User has already voted for this state')
    }

    if (!canApprove.canApprove) {
      throw new PermissionDeniedError('this approval', 'submit')
    }

    // If approving as a role, verify the role is valid
    let roleName: string | null = null
    if (roleId) {
      const validRole = canApprove.asRoles.find((r) => r.id === roleId)
      if (!validRole) {
        throw new PermissionDeniedError(
          'this approval',
          'submit as the selected role for',
        )
      }
      roleName = validRole.name
    }

    // Check if already voted. Superseded votes don't count — after rework the
    // same user must vote again.
    //
    // This read is not the guarantee; the partial unique index
    // uq_wf_votes_active is. Between this SELECT and the INSERT below, a
    // second request from the same user can pass the same check, and two
    // live votes then count that person twice toward a quorum. The check
    // stays because it is what turns the common case into a clean 409
    // without reaching the database's error path.
    const existingVote = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
          eq(workflowApprovalVotes.userId, userId),
          isNull(workflowApprovalVotes.supersededAt),
        ),
      )
      .limit(1)

    if (existingVote.length > 0) {
      throw new ConflictError('Vote already submitted')
    }

    // Built at most once, and only if an interceptor asks for it. Interceptors
    // that bind a record to this approval should call it from `beforeVote`, so
    // the snapshot is taken before the write rather than from a later reading.
    let attested: Promise<ApprovalAttestation> | null = null
    const ctx: ApprovalContext = {
      instanceId,
      stateId,
      userId,
      vote,
      roleId: roleId ?? null,
      roleName,
      comments: comments ?? null,
      extras,
      attestation: () => {
        attested ??= this.buildApprovalAttestation(instanceId, stateId)
        return attested
      },
    }

    await ApprovalRegistry.beforeVote(ctx)

    return db.transaction(async (tx) => {
      let inserted
      try {
        inserted = takeFirst(
          await tx
            .insert(workflowApprovalVotes)
            .values({
              workflowInstanceId: instanceId,
              stateId,
              userId,
              roleId: roleId || null,
              vote,
              comments: comments || null,
            })
            .returning(),
        )
      } catch (error) {
        // The loser of the race the pre-check cannot close. Same error the
        // pre-check raises, so the caller sees 409 rather than a 500 that
        // reads like a malfunction. Thrown from inside the transaction, so
        // anything an interceptor bound to this vote rolls back with it.
        if (isUniqueViolation(error, { table: 'workflow_approval_votes' })) {
          throw new ConflictError('Vote already submitted')
        }
        throw error
      }

      const contributed = await ApprovalRegistry.afterVote(inserted.id, ctx, tx)

      return {
        id: inserted.id,
        vote: inserted.vote,
        votedAt: inserted.votedAt,
        ...contributed,
      }
    })
  }

  /**
   * Gather the human-meaningful facts about what an approval covers.
   *
   * These go into the signed payload so a signature can be shown to an auditor
   * years later as "X approved item ABC-123 rev B at state Review", without
   * depending on the current state of those records.
   */
  private static async buildApprovalAttestation(
    instanceId: string,
    stateId: string,
  ): Promise<ApprovalAttestation> {
    const instance = (
      await db
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, instanceId))
        .limit(1)
    )[0]

    if (!instance) {
      throw new NotFoundError('Workflow instance', instanceId)
    }

    let stateName = stateId
    let workflow: Record<string, unknown> | null = null

    if (instance.workflowDefinitionId) {
      const definition = (
        await db
          .select()
          .from(workflowDefinitions)
          .where(eq(workflowDefinitions.id, instance.workflowDefinitionId))
          .limit(1)
      )[0]

      if (definition) {
        workflow = {
          definitionId: definition.id,
          name: definition.name,
          version: definition.version,
        }
        const states = (
          definition.definition as { states: Array<WorkflowState> }
        ).states
        stateName = states.find((s) => s.id === stateId)?.name ?? stateId
      }
    }

    let item: Record<string, unknown> | null = null
    if (instance.itemId) {
      const row = (
        await db
          .select({
            id: items.id,
            itemNumber: items.itemNumber,
            revision: items.revision,
            itemType: items.itemType,
            name: items.name,
            state: items.state,
          })
          .from(items)
          .where(eq(items.id, instance.itemId))
          .limit(1)
      )[0]

      if (row) item = { ...row }
    }

    return {
      itemId: instance.itemId,
      stateName,
      item,
      workflow,
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

    const instanceRow = instance[0]
    if (!instanceRow) {
      return {
        canApprove: false,
        asUser: false,
        asRoles: [],
        alreadyVoted: false,
      }
    }

    // Approvers from both levels gate this state (WI-4.2). A missing
    // definition is fine — instance approvers can still exist.
    const stateApprovers = await this.getEffectiveApprovers(
      instanceRow.workflowDefinitionId,
      instanceId,
      stateId,
    )

    // Check if user has already voted (active votes only — a superseded
    // vote means the user may, and must, vote again)
    const existingVote = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
          eq(workflowApprovalVotes.userId, userId),
          isNull(workflowApprovalVotes.supersededAt),
        ),
      )
      .limit(1)

    const priorVote = existingVote[0]
    const alreadyVoted = priorVote !== undefined

    if (stateApprovers.length === 0) {
      // No named approvers — anyone may vote (this is how requiredCount-
      // only gating collects votes), but still at most once
      return {
        canApprove: !alreadyVoted,
        asUser: true,
        asRoles: [],
        alreadyVoted,
        existingVote: priorVote?.vote as 'approved' | 'rejected' | undefined,
      }
    }

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
      existingVote: priorVote?.vote as 'approved' | 'rejected' | undefined,
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

    const instanceRow = instance[0]
    if (!instanceRow) {
      return {
        met: false,
        required: 0,
        current: 0,
        pending: [],
        totalApproved: 0,
      }
    }

    // Approvers from both levels gate this state (WI-4.2)
    const stateApprovers = await this.getEffectiveApprovers(
      instanceRow.workflowDefinitionId,
      instanceId,
      stateId,
    )
    const requiredApprovers = stateApprovers.filter((a) => a.isRequired)

    // Active approved votes for this state — needed even with no named
    // approvers, because totalApproved feeds the requiredCount gate
    const votes = await db
      .select()
      .from(workflowApprovalVotes)
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          eq(workflowApprovalVotes.stateId, stateId),
          eq(workflowApprovalVotes.vote, 'approved'),
          isNull(workflowApprovalVotes.supersededAt),
        ),
      )
    const totalApproved = new Set(votes.map((v) => v.userId)).size

    if (requiredApprovers.length === 0) {
      // No required approvers - the named-approver requirement is met
      return { met: true, required: 0, current: 0, pending: [], totalApproved }
    }

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
      totalApproved,
    }
  }

  /**
   * Soft-invalidate all active votes for the given states, called when a
   * workflow transitions backward (rework). Votes are marked superseded,
   * never deleted — an append-only audit trail has to show that a vote
   * existed and was superseded, not that it vanished (decision D7). All
   * gating and status reads consider only active (non-superseded) votes,
   * so rework requires fresh approvals.
   */
  static async supersedeApprovalsForStates(
    instanceId: string,
    stateIds: Array<string>,
  ): Promise<void> {
    if (stateIds.length === 0) return

    await db
      .update(workflowApprovalVotes)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(workflowApprovalVotes.workflowInstanceId, instanceId),
          inArray(workflowApprovalVotes.stateId, stateIds),
          isNull(workflowApprovalVotes.supersededAt),
        ),
      )
  }

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Bulk-resolve display names for user/role references in two queries
   * (one per kind) instead of one query per row (F15 N+1). Keys are
   * `${type}:${id}`.
   */
  private static async resolveApproverNames(
    refs: Iterable<{ type: 'user' | 'role'; id: string }>,
  ): Promise<Map<string, string>> {
    const userIds = new Set<string>()
    const roleIds = new Set<string>()
    for (const ref of refs) {
      if (ref.type === 'user') userIds.add(ref.id)
      else roleIds.add(ref.id)
    }

    const names = new Map<string, string>()
    if (userIds.size > 0) {
      const rows = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, [...userIds]))
      for (const row of rows) names.set(`user:${row.id}`, row.name || row.email)
    }
    if (roleIds.size > 0) {
      const rows = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(inArray(roles.id, [...roleIds]))
      for (const row of rows) names.set(`role:${row.id}`, row.name)
    }
    return names
  }

  private static approverNameFrom(
    names: Map<string, string>,
    type: 'user' | 'role',
    id: string,
  ): string {
    return (
      names.get(`${type}:${id}`) ??
      (type === 'user' ? 'Unknown User' : 'Unknown Role')
    )
  }

  /**
   * Resolve one approver name; single-row paths only — list paths use the
   * bulk resolver above.
   */
  private static async resolveApproverName(
    type: 'user' | 'role',
    id: string,
  ): Promise<string> {
    const names = await this.resolveApproverNames([{ type, id }])
    return this.approverNameFrom(names, type, id)
  }

  /**
   * Build approval status for a state. Approvers may come from the
   * definition level, the instance level, or a merge of both.
   */
  private static buildApprovalStatus(
    state: WorkflowState,
    approvers: Array<{
      approverType: 'user' | 'role'
      approverId: string
      approverName?: string
      isRequired: boolean
    }>,
    votes: Array<{
      id: string
      userId: string
      roleId: string | null
      vote: string
      comments: string | null
      votedAt: Date
    }>,
    voterNames: Map<string, string>,
  ): ApprovalStatus {
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

      // Get voter info if there's a vote (names prebuilt by the caller)
      let votedBy: { id: string; name: string } | undefined
      if (matchingVote) {
        votedBy = {
          id: matchingVote.userId,
          name: this.approverNameFrom(voterNames, 'user', matchingVote.userId),
        }
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
