/**
 * WorkflowApprovalService Tests
 *
 * Integration tests for the WorkflowApprovalService class.
 * Tests cover definition-level approver management and instance-level approval tracking.
 *
 * Run: npm run test -- src/lib/workflows/WorkflowApprovalService.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { WorkflowApprovalService } from './WorkflowApprovalService'
import { WorkflowService } from './WorkflowService'
import type { CreateWorkflowInput } from './types'
import { TestDatabase } from '@/__tests__/helpers/db'
import {
  assignRoleToUser,
  createCustomTestRole,
  insertTestRole,
  insertTestUser,
} from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'

describe('WorkflowApprovalService', () => {
  const testDb = new TestDatabase()

  // Test prefix to avoid collisions
  let testPrefix: string

  beforeAll(() => {
    testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    testPrefix = `WFA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // Helper to create workflow input
  function createWorkflowInput(
    overrides?: Partial<CreateWorkflowInput>,
  ): CreateWorkflowInput {
    return {
      name: `Test Workflow ${testPrefix}-${Math.random().toString(36).slice(2, 8)}`,
      definitionType: 'workflow',
      workflowType: 'strict',
      states: [
        { id: 'draft', name: 'Draft', color: 'gray', isInitial: true },
        { id: 'review', name: 'In Review', color: 'yellow' },
        { id: 'approved', name: 'Approved', color: 'green', isFinal: true },
        { id: 'rejected', name: 'Rejected', color: 'red', isFinal: true },
      ],
      transitions: [
        {
          id: 't1',
          name: 'Submit for Review',
          fromStateId: 'draft',
          toStateId: 'review',
        },
        {
          id: 't2',
          name: 'Approve',
          fromStateId: 'review',
          toStateId: 'approved',
        },
        {
          id: 't3',
          name: 'Reject',
          fromStateId: 'review',
          toStateId: 'rejected',
        },
        {
          id: 't4',
          name: 'Return to Draft',
          fromStateId: 'review',
          toStateId: 'draft',
        },
      ],
      ...overrides,
    }
  }

  // Helper for unique item numbers
  function uniqueItemNumber(): string {
    return `${testPrefix}-${Math.random().toString(36).slice(2, 8)}`
  }

  // Helper to create a workflow and instance
  async function createWorkflowWithInstance() {
    const user = await insertTestUser(testDb.db)
    const workflow = await WorkflowService.create(createWorkflowInput())
    // Create an actual item in the database (required by foreign key constraint)
    const { item } = await insertTestPart(testDb.db, null, user.id, {
      itemNumber: uniqueItemNumber(),
    })
    const instance = await WorkflowService.startInstance(workflow.id, item.id)
    return { user, workflow, instance, item }
  }

  describe('Definition-level Approver Management', () => {
    describe('getStateApprovers', () => {
      it('returns empty array when no approvers configured', async () => {
        const workflow = await WorkflowService.create(createWorkflowInput())

        const approvers = await WorkflowApprovalService.getStateApprovers(
          workflow.id,
          'review',
        )

        expect(approvers).toEqual([])
      })

      it('returns approvers for a state', async () => {
        const user = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        const approvers = await WorkflowApprovalService.getStateApprovers(
          workflow.id,
          'review',
        )

        expect(approvers).toHaveLength(1)
        expect(approvers[0].approverType).toBe('user')
        expect(approvers[0].approverId).toBe(user.id)
        expect(approvers[0].isRequired).toBe(true)
        expect(approvers[0].approverName).toBe(user.name)
      })

      it('returns both user and role approvers', async () => {
        const user = await insertTestUser(testDb.db)
        const role = await insertTestRole(
          testDb.db,
          createCustomTestRole('Reviewer', { Part: ['read'] }),
        )
        const workflow = await WorkflowService.create(createWorkflowInput())

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )
        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'role', id: role.id, isRequired: false },
          user.id,
        )

        const approvers = await WorkflowApprovalService.getStateApprovers(
          workflow.id,
          'review',
        )

        expect(approvers).toHaveLength(2)
        const userApprover = approvers.find((a) => a.approverType === 'user')
        const roleApprover = approvers.find((a) => a.approverType === 'role')

        expect(userApprover?.approverId).toBe(user.id)
        expect(userApprover?.isRequired).toBe(true)
        expect(roleApprover?.approverId).toBe(role.id)
        expect(roleApprover?.isRequired).toBe(false)
        expect(roleApprover?.approverName).toBe('Reviewer')
      })
    })

    describe('getAllStateApprovers', () => {
      it('returns empty object when no approvers', async () => {
        const workflow = await WorkflowService.create(createWorkflowInput())

        const allApprovers = await WorkflowApprovalService.getAllStateApprovers(
          workflow.id,
        )

        expect(allApprovers).toEqual({})
      })

      it('returns approvers grouped by state', async () => {
        const user1 = await insertTestUser(testDb.db)
        const user2 = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user1.id, isRequired: true },
          user1.id,
        )
        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'approved',
          { type: 'user', id: user2.id, isRequired: true },
          user1.id,
        )

        const allApprovers = await WorkflowApprovalService.getAllStateApprovers(
          workflow.id,
        )

        expect(Object.keys(allApprovers)).toHaveLength(2)
        expect(allApprovers['review']).toHaveLength(1)
        expect(allApprovers['approved']).toHaveLength(1)
        expect(allApprovers['review'][0].approverId).toBe(user1.id)
        expect(allApprovers['approved'][0].approverId).toBe(user2.id)
      })
    })

    describe('setStateApprovers', () => {
      it('sets multiple approvers for a state', async () => {
        const user1 = await insertTestUser(testDb.db)
        const user2 = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        const result = await WorkflowApprovalService.setStateApprovers(
          workflow.id,
          'review',
          [
            { type: 'user', id: user1.id, isRequired: true },
            { type: 'user', id: user2.id, isRequired: false },
          ],
          user1.id,
        )

        expect(result).toHaveLength(2)
        expect(result.map((r) => r.approverId).sort()).toEqual(
          [user1.id, user2.id].sort(),
        )
      })

      it('replaces existing approvers', async () => {
        const user1 = await insertTestUser(testDb.db)
        const user2 = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        // First set
        await WorkflowApprovalService.setStateApprovers(
          workflow.id,
          'review',
          [{ type: 'user', id: user1.id, isRequired: true }],
          user1.id,
        )

        // Replace with different approver
        await WorkflowApprovalService.setStateApprovers(
          workflow.id,
          'review',
          [{ type: 'user', id: user2.id, isRequired: false }],
          user1.id,
        )

        const approvers = await WorkflowApprovalService.getStateApprovers(
          workflow.id,
          'review',
        )

        expect(approvers).toHaveLength(1)
        expect(approvers[0].approverId).toBe(user2.id)
        expect(approvers[0].isRequired).toBe(false)
      })

      it('clears all approvers when empty array passed', async () => {
        const user = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        // First set approvers
        await WorkflowApprovalService.setStateApprovers(
          workflow.id,
          'review',
          [{ type: 'user', id: user.id, isRequired: true }],
          user.id,
        )

        // Clear them
        const result = await WorkflowApprovalService.setStateApprovers(
          workflow.id,
          'review',
          [],
          user.id,
        )

        expect(result).toEqual([])

        const approvers = await WorkflowApprovalService.getStateApprovers(
          workflow.id,
          'review',
        )
        expect(approvers).toHaveLength(0)
      })
    })

    describe('addStateApprover', () => {
      it('adds a user approver', async () => {
        const user = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        const result = await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        expect(result.id).toBeDefined()
        expect(result.approverType).toBe('user')
        expect(result.approverId).toBe(user.id)
        expect(result.stateId).toBe('review')
        expect(result.isRequired).toBe(true)
      })

      it('adds a role approver', async () => {
        const user = await insertTestUser(testDb.db)
        const role = await insertTestRole(
          testDb.db,
          createCustomTestRole('Approver Role', { Part: ['approve'] }),
        )
        const workflow = await WorkflowService.create(createWorkflowInput())

        const result = await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'role', id: role.id, isRequired: true },
          user.id,
        )

        expect(result.approverType).toBe('role')
        expect(result.approverId).toBe(role.id)
        expect(result.approverName).toBe('Approver Role')
      })

      it('throws error when adding duplicate approver', async () => {
        const user = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        await expect(
          WorkflowApprovalService.addStateApprover(
            workflow.id,
            'review',
            { type: 'user', id: user.id, isRequired: false },
            user.id,
          ),
        ).rejects.toThrow('Approver already exists for this state')
      })
    })

    describe('removeStateApprover', () => {
      it('removes an approver', async () => {
        const user = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        const approver = await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        await WorkflowApprovalService.removeStateApprover(approver.id)

        const approvers = await WorkflowApprovalService.getStateApprovers(
          workflow.id,
          'review',
        )
        expect(approvers).toHaveLength(0)
      })
    })

    describe('updateStateApprover', () => {
      it('updates required status', async () => {
        const user = await insertTestUser(testDb.db)
        const workflow = await WorkflowService.create(createWorkflowInput())

        const approver = await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        const updated = await WorkflowApprovalService.updateStateApprover(
          approver.id,
          false,
        )

        expect(updated.isRequired).toBe(false)
        expect(updated.approverId).toBe(user.id)
      })

      it('throws error for non-existent approver', async () => {
        // Use a valid UUID format that doesn't exist
        const fakeApproverId = '00000000-0000-0000-0000-000000000000'
        await expect(
          WorkflowApprovalService.updateStateApprover(fakeApproverId, true),
        ).rejects.toThrow('Approver not found')
      })
    })
  })

  describe('Instance-level Approval Tracking', () => {
    describe('canUserApprove', () => {
      it('returns true when user is direct approver', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        const result = await WorkflowApprovalService.canUserApprove(
          instance.id,
          'draft',
          user.id,
        )

        expect(result.canApprove).toBe(true)
        expect(result.asUser).toBe(true)
        expect(result.asRoles).toHaveLength(0)
        expect(result.alreadyVoted).toBe(false)
      })

      it('returns true when user has approver role', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()
        const role = await insertTestRole(
          testDb.db,
          createCustomTestRole('Reviewer Role', { Part: ['read'] }),
        )
        await assignRoleToUser(testDb.db, user.id, role.id)

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'role', id: role.id, isRequired: true },
          user.id,
        )

        const result = await WorkflowApprovalService.canUserApprove(
          instance.id,
          'draft',
          user.id,
        )

        expect(result.canApprove).toBe(true)
        expect(result.asUser).toBe(false)
        expect(result.asRoles).toHaveLength(1)
        expect(result.asRoles[0].id).toBe(role.id)
        expect(result.asRoles[0].name).toBe('Reviewer Role')
      })

      it('returns false when user is not an approver', async () => {
        const { workflow, instance } = await createWorkflowWithInstance()
        const otherUser = await insertTestUser(testDb.db)
        const approverUser = await insertTestUser(testDb.db)

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: approverUser.id, isRequired: true },
          approverUser.id,
        )

        const result = await WorkflowApprovalService.canUserApprove(
          instance.id,
          'draft',
          otherUser.id,
        )

        expect(result.canApprove).toBe(false)
        expect(result.asUser).toBe(false)
        expect(result.asRoles).toHaveLength(0)
      })

      it('returns true when no approvers configured (anyone can approve)', async () => {
        const { user, instance } = await createWorkflowWithInstance()

        const result = await WorkflowApprovalService.canUserApprove(
          instance.id,
          'draft',
          user.id,
        )

        expect(result.canApprove).toBe(true)
        expect(result.asUser).toBe(true)
      })

      it('returns alreadyVoted=true after user has voted', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
        )

        const result = await WorkflowApprovalService.canUserApprove(
          instance.id,
          'draft',
          user.id,
        )

        expect(result.canApprove).toBe(false)
        expect(result.alreadyVoted).toBe(true)
        expect(result.existingVote).toBe('approved')
      })
    })

    describe('submitApproval', () => {
      it('submits an approval vote', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        const result = await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
        )

        expect(result.id).toBeDefined()
        expect(result.vote).toBe('approved')
        expect(result.votedAt).toBeDefined()
      })

      it('submits a rejection vote with comments', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        const result = await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'rejected',
          undefined,
          'Needs more details',
        )

        expect(result.vote).toBe('rejected')

        const status = await WorkflowApprovalService.getStateApprovals(
          instance.id,
          'draft',
        )
        const approverStatus = status.requiredApprovers[0]
        expect(approverStatus.vote).toBe('rejected')
        expect(approverStatus.comments).toBe('Needs more details')
      })

      it('submits approval on behalf of a role', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()
        const role = await insertTestRole(
          testDb.db,
          createCustomTestRole('Approver Role', { Part: ['approve'] }),
        )
        await assignRoleToUser(testDb.db, user.id, role.id)

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'role', id: role.id, isRequired: true },
          user.id,
        )

        const result = await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
          role.id,
        )

        expect(result.vote).toBe('approved')

        const status = await WorkflowApprovalService.getStateApprovals(
          instance.id,
          'draft',
        )
        expect(status.requiredApprovers[0].vote).toBe('approved')
      })

      it('throws error when user is not authorized', async () => {
        const { workflow, instance } = await createWorkflowWithInstance()
        const approver = await insertTestUser(testDb.db)
        const nonApprover = await insertTestUser(testDb.db)

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: approver.id, isRequired: true },
          approver.id,
        )

        await expect(
          WorkflowApprovalService.submitApproval(
            instance.id,
            'draft',
            nonApprover.id,
            'approved',
          ),
        ).rejects.toThrow('User is not authorized to approve at this state')
      })

      it('throws error when user has already voted', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
        )

        await expect(
          WorkflowApprovalService.submitApproval(
            instance.id,
            'draft',
            user.id,
            'rejected',
          ),
        ).rejects.toThrow('User has already voted for this state')
      })

      it('throws error for invalid role', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        await expect(
          WorkflowApprovalService.submitApproval(
            instance.id,
            'draft',
            user.id,
            'approved',
            'invalid-role-id',
          ),
        ).rejects.toThrow('User cannot approve as this role')
      })
    })

    describe('getApprovals', () => {
      it('returns approval status for all states', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        const approvals = await WorkflowApprovalService.getApprovals(
          instance.id,
        )

        expect(Object.keys(approvals)).toContain('draft')
        expect(Object.keys(approvals)).toContain('review')
        expect(Object.keys(approvals)).toContain('approved')
        expect(Object.keys(approvals)).toContain('rejected')

        expect(approvals['review'].requiredApprovers).toHaveLength(1)
        expect(approvals['draft'].requiredApprovers).toHaveLength(0)
      })

      it('includes vote information in approval status', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
          undefined,
          'Looks good!',
        )

        const approvals = await WorkflowApprovalService.getApprovals(
          instance.id,
        )

        const draftApproval = approvals['draft']
        expect(draftApproval.isComplete).toBe(true)
        expect(draftApproval.approvedCount).toBe(1)
        expect(draftApproval.requiredCount).toBe(1)
        expect(draftApproval.requiredApprovers[0].vote).toBe('approved')
        expect(draftApproval.requiredApprovers[0].comments).toBe('Looks good!')
        expect(draftApproval.requiredApprovers[0].votedBy?.id).toBe(user.id)
      })

      it('throws error for non-existent instance', async () => {
        // Use a valid UUID format that doesn't exist
        const fakeId = '00000000-0000-0000-0000-000000000000'
        await expect(
          WorkflowApprovalService.getApprovals(fakeId),
        ).rejects.toThrow('Workflow instance not found')
      })
    })

    describe('getStateApprovals', () => {
      it('returns approval status for specific state', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        const status = await WorkflowApprovalService.getStateApprovals(
          instance.id,
          'review',
        )

        expect(status.stateId).toBe('review')
        expect(status.stateName).toBe('In Review')
        expect(status.requiredApprovers).toHaveLength(1)
        expect(status.optionalApprovers).toHaveLength(0)
        expect(status.isComplete).toBe(false)
        expect(status.approvedCount).toBe(0)
        expect(status.requiredCount).toBe(1)
      })

      it('separates required and optional approvers', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()
        const optionalApprover = await insertTestUser(testDb.db)

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )
        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: optionalApprover.id, isRequired: false },
          user.id,
        )

        const status = await WorkflowApprovalService.getStateApprovals(
          instance.id,
          'review',
        )

        expect(status.requiredApprovers).toHaveLength(1)
        expect(status.optionalApprovers).toHaveLength(1)
        expect(status.requiredApprovers[0].approverId).toBe(user.id)
        expect(status.optionalApprovers[0].approverId).toBe(optionalApprover.id)
      })

      it('throws error for non-existent state', async () => {
        const { instance } = await createWorkflowWithInstance()

        await expect(
          WorkflowApprovalService.getStateApprovals(
            instance.id,
            'invalid-state',
          ),
        ).rejects.toThrow('State not found in workflow definition')
      })
    })

    describe('areApprovalsComplete', () => {
      it('returns met=true when no required approvers', async () => {
        const { instance } = await createWorkflowWithInstance()

        const result = await WorkflowApprovalService.areApprovalsComplete(
          instance.id,
          'draft',
        )

        expect(result.met).toBe(true)
        expect(result.required).toBe(0)
        expect(result.current).toBe(0)
        expect(result.pending).toHaveLength(0)
      })

      it('returns met=false when required approvals missing', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        const result = await WorkflowApprovalService.areApprovalsComplete(
          instance.id,
          'draft',
        )

        expect(result.met).toBe(false)
        expect(result.required).toBe(1)
        expect(result.current).toBe(0)
        expect(result.pending).toHaveLength(1)
        expect(result.pending[0].type).toBe('user')
        expect(result.pending[0].id).toBe(user.id)
      })

      it('returns met=true when all required approvals obtained', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
        )

        const result = await WorkflowApprovalService.areApprovalsComplete(
          instance.id,
          'draft',
        )

        expect(result.met).toBe(true)
        expect(result.required).toBe(1)
        expect(result.current).toBe(1)
        expect(result.pending).toHaveLength(0)
      })

      it('does not count optional approvers in requirement', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: false },
          user.id,
        )

        const result = await WorkflowApprovalService.areApprovalsComplete(
          instance.id,
          'draft',
        )

        expect(result.met).toBe(true)
        expect(result.required).toBe(0)
      })

      it('tracks multiple required approvers', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()
        const user2 = await insertTestUser(testDb.db)

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )
        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user2.id, isRequired: true },
          user.id,
        )

        // Only one approval
        await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
        )

        const result = await WorkflowApprovalService.areApprovalsComplete(
          instance.id,
          'draft',
        )

        expect(result.met).toBe(false)
        expect(result.required).toBe(2)
        expect(result.current).toBe(1)
        expect(result.pending).toHaveLength(1)
        expect(result.pending[0].id).toBe(user2.id)
      })

      it('counts role-based approval correctly', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()
        const role = await insertTestRole(
          testDb.db,
          createCustomTestRole('Required Approvers', { Part: ['approve'] }),
        )
        await assignRoleToUser(testDb.db, user.id, role.id)

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'role', id: role.id, isRequired: true },
          user.id,
        )

        await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
          role.id,
        )

        const result = await WorkflowApprovalService.areApprovalsComplete(
          instance.id,
          'draft',
        )

        expect(result.met).toBe(true)
        expect(result.required).toBe(1)
        expect(result.current).toBe(1)
      })
    })

    describe('clearStateApprovals', () => {
      it('clears all approvals for a state', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()

        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'draft',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )

        await WorkflowApprovalService.submitApproval(
          instance.id,
          'draft',
          user.id,
          'approved',
        )

        await WorkflowApprovalService.clearStateApprovals(instance.id, 'draft')

        // User should be able to approve again
        const canApprove = await WorkflowApprovalService.canUserApprove(
          instance.id,
          'draft',
          user.id,
        )

        expect(canApprove.canApprove).toBe(true)
        expect(canApprove.alreadyVoted).toBe(false)
      })
    })

    describe('clearApprovalsAfterState', () => {
      it('clears approvals for multiple states', async () => {
        const { user, workflow, instance } = await createWorkflowWithInstance()
        const user2 = await insertTestUser(testDb.db)

        // Add approvers to multiple states
        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'review',
          { type: 'user', id: user.id, isRequired: true },
          user.id,
        )
        await WorkflowApprovalService.addStateApprover(
          workflow.id,
          'approved',
          { type: 'user', id: user2.id, isRequired: true },
          user.id,
        )

        // Submit approvals
        await WorkflowApprovalService.submitApproval(
          instance.id,
          'review',
          user.id,
          'approved',
        )
        await WorkflowApprovalService.submitApproval(
          instance.id,
          'approved',
          user2.id,
          'approved',
        )

        // Clear approvals for both states
        await WorkflowApprovalService.clearApprovalsAfterState(instance.id, [
          'review',
          'approved',
        ])

        // Both users should be able to approve again
        const canApprove1 = await WorkflowApprovalService.canUserApprove(
          instance.id,
          'review',
          user.id,
        )
        const canApprove2 = await WorkflowApprovalService.canUserApprove(
          instance.id,
          'approved',
          user2.id,
        )

        expect(canApprove1.alreadyVoted).toBe(false)
        expect(canApprove2.alreadyVoted).toBe(false)
      })

      it('does nothing with empty state array', async () => {
        const { instance } = await createWorkflowWithInstance()

        // Should not throw
        await WorkflowApprovalService.clearApprovalsAfterState(instance.id, [])
      })
    })
  })

  describe('Edge Cases', () => {
    it('handles non-existent workflow instance gracefully', async () => {
      // Create a valid UUID that doesn't exist
      const fakeId = '00000000-0000-0000-0000-000000000000'
      const fakeUserId = '00000000-0000-0000-0000-000000000001'

      const result = await WorkflowApprovalService.canUserApprove(
        fakeId,
        'draft',
        fakeUserId,
      )

      expect(result.canApprove).toBe(false)
      expect(result.asUser).toBe(false)
      expect(result.asRoles).toHaveLength(0)
    })

    it('handles multiple users in same role correctly', async () => {
      const { user, workflow, instance } = await createWorkflowWithInstance()
      const user2 = await insertTestUser(testDb.db)
      const role = await insertTestRole(
        testDb.db,
        createCustomTestRole('Shared Role', { Part: ['approve'] }),
      )
      await assignRoleToUser(testDb.db, user.id, role.id)
      await assignRoleToUser(testDb.db, user2.id, role.id)

      await WorkflowApprovalService.addStateApprover(
        workflow.id,
        'draft',
        { type: 'role', id: role.id, isRequired: true },
        user.id,
      )

      // First user approves
      await WorkflowApprovalService.submitApproval(
        instance.id,
        'draft',
        user.id,
        'approved',
        role.id,
      )

      // Second user can still vote (they have the role)
      // But the role requirement is already met
      const completionStatus =
        await WorkflowApprovalService.areApprovalsComplete(instance.id, 'draft')

      expect(completionStatus.met).toBe(true)
      expect(completionStatus.required).toBe(1)
      expect(completionStatus.current).toBe(1)
    })
  })
})
