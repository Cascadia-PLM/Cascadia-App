/**
 * ProgramService Tests
 *
 * Integration tests for the ProgramService class.
 * Tests cover program CRUD, membership management, search, and access control.
 *
 * Run: npm run test -- src/lib/services/ProgramService.test.ts
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
import { ProgramService } from './ProgramService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { NotFoundError, ValidationError } from '@/lib/errors'

describe('ProgramService', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  /**
   * Helper to build a unique program code per test invocation.
   */
  function uniqueCode(prefix = 'PRG') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
  }

  // ==========================================================================
  // create()
  // ==========================================================================

  describe('create()', () => {
    it('creates a program with correct fields', async () => {
      const code = uniqueCode()
      const program = await ProgramService.create(
        {
          name: 'Alpha Program',
          code,
          description: 'Test description',
          customer: 'Acme Corp',
          contractNumber: 'C-1234',
        },
        user.id,
      )

      expect(program).toBeDefined()
      expect(program.id).toBeDefined()
      expect(program.name).toBe('Alpha Program')
      expect(program.code).toBe(code)
      expect(program.description).toBe('Test description')
      expect(program.customer).toBe('Acme Corp')
      expect(program.contractNumber).toBe('C-1234')
      expect(program.status).toBe('Active')
      expect(program.createdBy).toBe(user.id)
    })

    it('auto-adds creator as admin member', async () => {
      const program = await ProgramService.create(
        { name: 'Beta Program', code: uniqueCode() },
        user.id,
      )

      const member = await ProgramService.getMember(program.id, user.id)
      expect(member).not.toBeNull()
      expect(member!.role).toBe('admin')
      expect(member!.canCreateEco).toBe(true)
      expect(member!.canApproveEco).toBe(true)
      expect(member!.canManageProducts).toBe(true)
    })

    it('throws ValidationError on duplicate code', async () => {
      const code = uniqueCode()
      await ProgramService.create({ name: 'First', code }, user.id)

      await expect(
        ProgramService.create({ name: 'Second', code }, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('validates required fields via Zod', async () => {
      // Missing name (empty string)
      await expect(
        ProgramService.create({ name: '', code: uniqueCode() }, user.id),
      ).rejects.toThrow()

      // Missing code (empty string)
      await expect(
        ProgramService.create({ name: 'Test', code: '' }, user.id),
      ).rejects.toThrow()
    })

    it('validates code format (uppercase alphanumeric with hyphens)', async () => {
      await expect(
        ProgramService.create(
          { name: 'Bad Code', code: 'lower-case' },
          user.id,
        ),
      ).rejects.toThrow()
    })

    it('defaults status to Active when not provided', async () => {
      const program = await ProgramService.create(
        { name: 'Default Status', code: uniqueCode() },
        user.id,
      )
      expect(program.status).toBe('Active')
    })
  })

  // ==========================================================================
  // getById()
  // ==========================================================================

  describe('getById()', () => {
    it('returns program when found', async () => {
      const created = await ProgramService.create(
        { name: 'Lookup Test', code: uniqueCode() },
        user.id,
      )

      const found = await ProgramService.getById(created.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.name).toBe('Lookup Test')
    })

    it('returns null for non-existent ID', async () => {
      const found = await ProgramService.getById(
        '00000000-0000-0000-0000-000000000000',
      )
      expect(found).toBeNull()
    })
  })

  // ==========================================================================
  // update()
  // ==========================================================================

  describe('update()', () => {
    it('updates program fields', async () => {
      const program = await ProgramService.create(
        { name: 'Original', code: uniqueCode() },
        user.id,
      )

      const updated = await ProgramService.update(
        program.id,
        { name: 'Updated Name', customer: 'New Customer' },
        user.id,
      )

      expect(updated.name).toBe('Updated Name')
      expect(updated.customer).toBe('New Customer')
      expect(updated.updatedBy).toBe(user.id)
    })

    it('throws NotFoundError for non-existent program', async () => {
      await expect(
        ProgramService.update(
          '00000000-0000-0000-0000-000000000000',
          { name: 'Nope' },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('throws ValidationError on duplicate code when updating', async () => {
      const codeA = uniqueCode('A')
      const codeB = uniqueCode('B')
      await ProgramService.create({ name: 'Program A', code: codeA }, user.id)
      const programB = await ProgramService.create(
        { name: 'Program B', code: codeB },
        user.id,
      )

      await expect(
        ProgramService.update(programB.id, { code: codeA }, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('allows updating to the same code it already has', async () => {
      const code = uniqueCode()
      const program = await ProgramService.create(
        { name: 'Same Code', code },
        user.id,
      )

      // Updating name but keeping same code should not throw
      const updated = await ProgramService.update(
        program.id,
        { name: 'Renamed', code },
        user.id,
      )
      expect(updated.name).toBe('Renamed')
    })
  })

  // ==========================================================================
  // delete()
  // ==========================================================================

  describe('delete()', () => {
    it('deletes an existing program', async () => {
      const program = await ProgramService.create(
        { name: 'To Delete', code: uniqueCode() },
        user.id,
      )

      await ProgramService.delete(program.id)

      const found = await ProgramService.getById(program.id)
      expect(found).toBeNull()
    })

    it('throws NotFoundError for non-existent program', async () => {
      await expect(
        ProgramService.delete('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================================================
  // listAll()
  // ==========================================================================

  describe('listAll()', () => {
    it('returns all programs', async () => {
      await ProgramService.create(
        { name: 'List A', code: uniqueCode() },
        user.id,
      )
      await ProgramService.create(
        { name: 'List B', code: uniqueCode() },
        user.id,
      )

      const all = await ProgramService.listAll()
      expect(all.length).toBeGreaterThanOrEqual(2)
    })

    it('filters by status', async () => {
      await ProgramService.create(
        { name: 'Active Prog', code: uniqueCode(), status: 'Active' },
        user.id,
      )
      await ProgramService.create(
        { name: 'On Hold Prog', code: uniqueCode(), status: 'On Hold' },
        user.id,
      )

      const active = await ProgramService.listAll({ status: 'Active' })
      for (const p of active) {
        expect(p.status).toBe('Active')
      }
    })

    it('respects pagination (limit, offset)', async () => {
      // Create 3 programs
      for (let i = 0; i < 3; i++) {
        await ProgramService.create(
          { name: `Page ${i}`, code: uniqueCode() },
          user.id,
        )
      }

      const page = await ProgramService.listAll({ limit: 2, offset: 0 })
      expect(page.length).toBeLessThanOrEqual(2)
    })
  })

  // ==========================================================================
  // listByUser()
  // ==========================================================================

  describe('listByUser()', () => {
    it('returns programs user is a member of', async () => {
      // create() auto-adds the creator as admin member
      const program = await ProgramService.create(
        { name: 'My Program', code: uniqueCode() },
        user.id,
      )

      const result = await ProgramService.listByUser(user.id)
      expect(result.length).toBeGreaterThanOrEqual(1)

      const found = result.find((p) => p.id === program.id)
      expect(found).toBeDefined()
      expect(found!.userRole).toBe('admin')
    })

    it('returns empty array for user with no memberships', async () => {
      const otherUser = await insertTestUser(testDb.db)
      const result = await ProgramService.listByUser(otherUser.id)
      expect(result).toEqual([])
    })
  })

  // ==========================================================================
  // search()
  // ==========================================================================

  describe('search()', () => {
    it('returns results matching global search text', async () => {
      const code = uniqueCode('SRCH')
      await ProgramService.create(
        { name: 'Searchable Widget', code, customer: 'WidgetCo' },
        user.id,
      )

      const result = await ProgramService.search({
        globalSearch: 'Searchable Widget',
        programIds: null, // admin: all programs
      })

      expect(result.items.length).toBeGreaterThanOrEqual(1)
      expect(result.items.some((p) => p.code === code)).toBe(true)
    })

    it('filters by column values', async () => {
      const code = uniqueCode('COLF')
      await ProgramService.create(
        { name: 'Column Filter Test', code, status: 'On Hold' },
        user.id,
      )

      const result = await ProgramService.search({
        columnFilters: { status: ['On Hold'] },
        programIds: null,
      })

      for (const p of result.items) {
        expect(p.status).toBe('On Hold')
      }
    })

    it('supports sorting and pagination', async () => {
      for (let i = 0; i < 3; i++) {
        await ProgramService.create(
          { name: `Sort ${i}`, code: uniqueCode() },
          user.id,
        )
      }

      const result = await ProgramService.search({
        sortField: 'name',
        sortDirection: 'asc',
        limit: 2,
        offset: 0,
        programIds: null,
      })

      expect(result.items.length).toBeLessThanOrEqual(2)
      expect(result.total).toBeGreaterThanOrEqual(3)
    })

    it('scopes by programIds for access control', async () => {
      const programA = await ProgramService.create(
        { name: 'Scope A', code: uniqueCode() },
        user.id,
      )
      await ProgramService.create(
        { name: 'Scope B', code: uniqueCode() },
        user.id,
      )

      const result = await ProgramService.search({
        programIds: [programA.id],
      })

      expect(result.items.length).toBe(1)
      expect(result.items[0].id).toBe(programA.id)
    })

    it('returns empty when programIds is empty array (no access)', async () => {
      const result = await ProgramService.search({
        programIds: [],
      })
      expect(result.items).toEqual([])
      expect(result.total).toBe(0)
    })

    it('returns correct total for pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await ProgramService.create(
          { name: `Total ${i}`, code: uniqueCode() },
          user.id,
        )
      }

      const result = await ProgramService.search({
        limit: 2,
        offset: 0,
        programIds: null,
      })

      expect(result.items.length).toBeLessThanOrEqual(2)
      expect(result.total).toBeGreaterThanOrEqual(5)
    })
  })

  // ==========================================================================
  // addMember()
  // ==========================================================================

  describe('addMember()', () => {
    it('adds a member with correct role and default permissions', async () => {
      const program = await ProgramService.create(
        { name: 'Member Test', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)

      const member = await ProgramService.addMember(
        program.id,
        otherUser.id,
        'engineer',
        user.id,
      )

      expect(member.role).toBe('engineer')
      expect(member.canCreateEco).toBe(true)
      expect(member.canApproveEco).toBe(false)
      expect(member.canManageProducts).toBe(false)
    })

    it('sets admin default permissions correctly', async () => {
      const program = await ProgramService.create(
        { name: 'Admin Perms', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)

      const member = await ProgramService.addMember(
        program.id,
        otherUser.id,
        'admin',
        user.id,
      )

      expect(member.canCreateEco).toBe(true)
      expect(member.canApproveEco).toBe(true)
      expect(member.canManageProducts).toBe(true)
    })

    it('sets viewer default permissions correctly', async () => {
      const program = await ProgramService.create(
        { name: 'Viewer Perms', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)

      const member = await ProgramService.addMember(
        program.id,
        otherUser.id,
        'viewer',
        user.id,
      )

      expect(member.canCreateEco).toBe(false)
      expect(member.canApproveEco).toBe(false)
      expect(member.canManageProducts).toBe(false)
    })

    it('throws ValidationError when user is already a member', async () => {
      const program = await ProgramService.create(
        { name: 'Dup Member', code: uniqueCode() },
        user.id,
      )

      // user is already admin from create()
      await expect(
        ProgramService.addMember(program.id, user.id, 'engineer', user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('throws NotFoundError for non-existent program', async () => {
      await expect(
        ProgramService.addMember(
          '00000000-0000-0000-0000-000000000000',
          user.id,
          'engineer',
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================================================
  // updateMember()
  // ==========================================================================

  describe('updateMember()', () => {
    it('updates role', async () => {
      const program = await ProgramService.create(
        { name: 'Update Role', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)
      await ProgramService.addMember(
        program.id,
        otherUser.id,
        'engineer',
        user.id,
      )

      const updated = await ProgramService.updateMember(
        program.id,
        otherUser.id,
        { role: 'lead' },
      )

      expect(updated.role).toBe('lead')
    })

    it('updates permissions (canCreateEco, canApproveEco)', async () => {
      const program = await ProgramService.create(
        { name: 'Update Perms', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)
      await ProgramService.addMember(
        program.id,
        otherUser.id,
        'viewer',
        user.id,
      )

      const updated = await ProgramService.updateMember(
        program.id,
        otherUser.id,
        { canCreateEco: true, canApproveEco: true },
      )

      expect(updated.canCreateEco).toBe(true)
      expect(updated.canApproveEco).toBe(true)
    })

    it('throws NotFoundError when member does not exist', async () => {
      const program = await ProgramService.create(
        { name: 'No Member', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)

      await expect(
        ProgramService.updateMember(program.id, otherUser.id, {
          role: 'lead',
        }),
      ).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================================================
  // removeMember()
  // ==========================================================================

  describe('removeMember()', () => {
    it('removes a member', async () => {
      const program = await ProgramService.create(
        { name: 'Remove Test', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)
      await ProgramService.addMember(
        program.id,
        otherUser.id,
        'engineer',
        user.id,
      )

      await ProgramService.removeMember(program.id, otherUser.id)

      const member = await ProgramService.getMember(program.id, otherUser.id)
      expect(member).toBeNull()
    })

    it('throws ValidationError when trying to remove the last admin', async () => {
      const program = await ProgramService.create(
        { name: 'Last Admin', code: uniqueCode() },
        user.id,
      )

      // user is the only admin (auto-added on create)
      await expect(
        ProgramService.removeMember(program.id, user.id),
      ).rejects.toThrow(ValidationError)
    })

    it('allows removing an admin when another admin exists', async () => {
      const program = await ProgramService.create(
        { name: 'Two Admins', code: uniqueCode() },
        user.id,
      )
      const otherAdmin = await insertTestUser(testDb.db)
      await ProgramService.addMember(
        program.id,
        otherAdmin.id,
        'admin',
        user.id,
      )

      // Now there are two admins; removing one should succeed
      await ProgramService.removeMember(program.id, user.id)

      const removed = await ProgramService.getMember(program.id, user.id)
      expect(removed).toBeNull()
    })

    it('throws NotFoundError when member does not exist', async () => {
      const program = await ProgramService.create(
        { name: 'No Such Member', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)

      await expect(
        ProgramService.removeMember(program.id, otherUser.id),
      ).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================================================
  // getMember()
  // ==========================================================================

  describe('getMember()', () => {
    it('returns member when found', async () => {
      const program = await ProgramService.create(
        { name: 'Get Member', code: uniqueCode() },
        user.id,
      )

      const member = await ProgramService.getMember(program.id, user.id)
      expect(member).not.toBeNull()
      expect(member!.userId).toBe(user.id)
      expect(member!.programId).toBe(program.id)
    })

    it('returns null when not a member', async () => {
      const program = await ProgramService.create(
        { name: 'Not Member', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)

      const member = await ProgramService.getMember(program.id, otherUser.id)
      expect(member).toBeNull()
    })
  })

  // ==========================================================================
  // listMembers()
  // ==========================================================================

  describe('listMembers()', () => {
    it('lists all members of a program', async () => {
      const program = await ProgramService.create(
        { name: 'List Members', code: uniqueCode() },
        user.id,
      )
      const user2 = await insertTestUser(testDb.db)
      const user3 = await insertTestUser(testDb.db)
      await ProgramService.addMember(program.id, user2.id, 'engineer', user.id)
      await ProgramService.addMember(program.id, user3.id, 'viewer', user.id)

      const members = await ProgramService.listMembers(program.id)
      // creator + 2 added = 3 members
      expect(members.length).toBe(3)
    })

    it('throws NotFoundError for non-existent program', async () => {
      await expect(
        ProgramService.listMembers('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundError)
    })
  })

  // ==========================================================================
  // canUserAccess() and getUserRole()
  // ==========================================================================

  describe('canUserAccess()', () => {
    it('returns true for a member', async () => {
      const program = await ProgramService.create(
        { name: 'Access Check', code: uniqueCode() },
        user.id,
      )

      const hasAccess = await ProgramService.canUserAccess(user.id, program.id)
      expect(hasAccess).toBe(true)
    })

    it('returns false for a non-member', async () => {
      const program = await ProgramService.create(
        { name: 'No Access', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)

      const hasAccess = await ProgramService.canUserAccess(
        otherUser.id,
        program.id,
      )
      expect(hasAccess).toBe(false)
    })
  })

  describe('getUserRole()', () => {
    it('returns role for a member', async () => {
      const program = await ProgramService.create(
        { name: 'Role Check', code: uniqueCode() },
        user.id,
      )

      const role = await ProgramService.getUserRole(user.id, program.id)
      expect(role).toBe('admin')
    })

    it('returns null for a non-member', async () => {
      const program = await ProgramService.create(
        { name: 'No Role', code: uniqueCode() },
        user.id,
      )
      const otherUser = await insertTestUser(testDb.db)

      const role = await ProgramService.getUserRole(otherUser.id, program.id)
      expect(role).toBeNull()
    })
  })
})
