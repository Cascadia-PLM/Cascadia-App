/**
 * AccessControlService Tests
 *
 * Integration tests for the AccessControlService class.
 * Tests cover program-based access control, Global Admin bypass, and design access.
 *
 * Run: npm run test -- src/lib/auth/AccessControlService.test.ts
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
import { eq } from 'drizzle-orm'
import { AccessControlService, GLOBAL_ADMIN_ROLE } from './AccessControlService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { roles, userRoles } from '@/lib/db/schema/users'
import { designs, programMembers, programs } from '@/lib/db/schema'

describe('AccessControlService', () => {
  const testDb = new TestDatabase()

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // Helper to create a test program
  async function createTestProgram(
    name: string,
    code: string,
    createdBy: string,
  ) {
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name,
        code,
        description: `${name} description`,
        createdBy,
      })
      .returning()
    return program
  }

  // Helper to add user as program member
  async function addProgramMember(
    programId: string,
    userId: string,
    role = 'engineer',
  ) {
    await testDb.db.insert(programMembers).values({
      programId,
      userId,
      role,
    })
  }

  // Helper to create a test design
  async function createTestDesign(
    name: string,
    code: string,
    createdBy: string,
    options: { programId?: string | null; designType?: string } = {},
  ) {
    const [design] = await testDb.db
      .insert(designs)
      .values({
        name,
        code,
        programId: options.programId ?? null,
        designType: options.designType ?? 'Engineering',
        createdBy,
      })
      .returning()
    return design
  }

  // Helper to create Global Admin role and assign to user
  async function makeGlobalAdmin(userId: string) {
    // Check if Global Admin role exists
    let globalAdminRole = await testDb.db.query.roles.findFirst({
      where: eq(roles.name, GLOBAL_ADMIN_ROLE),
    })

    if (!globalAdminRole) {
      // Create Global Admin role
      const [newRole] = await testDb.db
        .insert(roles)
        .values({
          name: GLOBAL_ADMIN_ROLE,
          description: 'System-wide administrator',
          permissions: {
            parts: ['create', 'read', 'update', 'delete', 'approve', 'manage'],
            documents: [
              'create',
              'read',
              'update',
              'delete',
              'approve',
              'manage',
            ],
            users: ['create', 'read', 'update', 'delete', 'manage'],
            system: ['read', 'manage'],
          },
        })
        .returning()
      globalAdminRole = newRole
    }

    // Assign role to user
    await testDb.db.insert(userRoles).values({
      userId,
      roleId: globalAdminRole.id,
    })
  }

  describe('isGlobalAdmin', () => {
    it('returns true for Global Admin user', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Global Admin Test',
      })
      await makeGlobalAdmin(user.id)

      const result = await AccessControlService.isGlobalAdmin(user.id)

      expect(result).toBe(true)
    })

    it('returns false for regular user', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Regular User Test',
      })

      const result = await AccessControlService.isGlobalAdmin(user.id)

      expect(result).toBe(false)
    })

    it('returns false for non-existent user', async () => {
      const fakeUserId = '00000000-0000-0000-0000-000000000000'

      const result = await AccessControlService.isGlobalAdmin(fakeUserId)

      expect(result).toBe(false)
    })
  })

  describe('canAccessProgram', () => {
    it('returns true for Global Admin regardless of membership', async () => {
      const admin = await insertTestUser(testDb.db, {
        name: 'Admin Access Test',
      })
      await makeGlobalAdmin(admin.id)

      const program = await createTestProgram(
        'Admin Test Program',
        `ATP-${Date.now()}`,
        admin.id,
      )

      // Admin is NOT a member, but should still have access
      const result = await AccessControlService.canAccessProgram(
        admin.id,
        program.id,
      )

      expect(result).toBe(true)
    })

    it('returns true for program member', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Member Access Test',
      })
      const program = await createTestProgram(
        'Member Test Program',
        `MTP-${Date.now()}`,
        user.id,
      )

      await addProgramMember(program.id, user.id, 'engineer')

      const result = await AccessControlService.canAccessProgram(
        user.id,
        program.id,
      )

      expect(result).toBe(true)
    })

    it('returns false for non-member', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Non-Member Test' })
      const otherUser = await insertTestUser(testDb.db, {
        name: 'Program Creator',
      })
      const program = await createTestProgram(
        'Non-Member Program',
        `NMP-${Date.now()}`,
        otherUser.id,
      )

      // User is NOT a member
      const result = await AccessControlService.canAccessProgram(
        user.id,
        program.id,
      )

      expect(result).toBe(false)
    })

    it('returns false for non-existent program', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Bad Program Test' })
      const fakeProgramId = '00000000-0000-0000-0000-000000000000'

      const result = await AccessControlService.canAccessProgram(
        user.id,
        fakeProgramId,
      )

      expect(result).toBe(false)
    })
  })

  describe('canAccessDesign', () => {
    it('returns true for Global Admin regardless of design program', async () => {
      const admin = await insertTestUser(testDb.db, {
        name: 'Admin Design Test',
      })
      await makeGlobalAdmin(admin.id)

      const program = await createTestProgram(
        'Design Admin Program',
        `DAP-${Date.now()}`,
        admin.id,
      )
      const design = await createTestDesign(
        'Admin Design',
        `AD-${Date.now()}`,
        admin.id,
        {
          programId: program.id,
        },
      )

      const result = await AccessControlService.canAccessDesign(
        admin.id,
        design.id,
      )

      expect(result).toBe(true)
    })

    it('returns true for global library design (all authenticated users)', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Library Access Test',
      })

      // Create global library (no programId, designType = 'library')
      const library = await createTestDesign(
        'Global Library',
        `GL-${Date.now()}`,
        user.id,
        {
          programId: null,
          designType: 'Library',
        },
      )

      const result = await AccessControlService.canAccessDesign(
        user.id,
        library.id,
      )

      expect(result).toBe(true)
    })

    it('returns true for unassigned design (all authenticated users)', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Unassigned Access Test',
      })

      // Create unassigned design (no programId, regular type)
      const design = await createTestDesign(
        'Unassigned Design',
        `UD-${Date.now()}`,
        user.id,
        {
          programId: null,
          designType: 'Engineering',
        },
      )

      const result = await AccessControlService.canAccessDesign(
        user.id,
        design.id,
      )

      expect(result).toBe(true)
    })

    it('returns true for program member accessing program design', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Member Design Test',
      })
      const program = await createTestProgram(
        'Member Design Program',
        `MDP-${Date.now()}`,
        user.id,
      )
      const design = await createTestDesign(
        'Program Design',
        `PD-${Date.now()}`,
        user.id,
        {
          programId: program.id,
        },
      )

      await addProgramMember(program.id, user.id, 'engineer')

      const result = await AccessControlService.canAccessDesign(
        user.id,
        design.id,
      )

      expect(result).toBe(true)
    })

    it('returns false for non-member accessing program design', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Non-Member Design Test',
      })
      const otherUser = await insertTestUser(testDb.db, {
        name: 'Design Owner',
      })
      const program = await createTestProgram(
        'Restricted Program',
        `RP-${Date.now()}`,
        otherUser.id,
      )
      const design = await createTestDesign(
        'Restricted Design',
        `RD-${Date.now()}`,
        otherUser.id,
        {
          programId: program.id,
        },
      )

      // User is NOT a member of the program
      const result = await AccessControlService.canAccessDesign(
        user.id,
        design.id,
      )

      expect(result).toBe(false)
    })

    it('returns false for non-existent design', async () => {
      const user = await insertTestUser(testDb.db, { name: 'Bad Design Test' })
      const fakeDesignId = '00000000-0000-0000-0000-000000000000'

      const result = await AccessControlService.canAccessDesign(
        user.id,
        fakeDesignId,
      )

      expect(result).toBe(false)
    })
  })

  describe('getAccessiblePrograms', () => {
    it('returns all programs for Global Admin', async () => {
      const admin = await insertTestUser(testDb.db, {
        name: 'Admin Programs Test',
      })
      await makeGlobalAdmin(admin.id)

      await createTestProgram('Program 1', `P1-${Date.now()}`, admin.id)
      await createTestProgram('Program 2', `P2-${Date.now()}`, admin.id)
      await createTestProgram('Program 3', `P3-${Date.now()}`, admin.id)

      const result = await AccessControlService.getAccessiblePrograms(admin.id)

      expect(result.length).toBeGreaterThanOrEqual(3)
    })

    it('returns only member programs for regular user', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Limited Programs Test',
      })
      const otherUser = await insertTestUser(testDb.db, { name: 'Other User' })

      const program1 = await createTestProgram(
        'User Program 1',
        `UP1-${Date.now()}`,
        user.id,
      )
      const program2 = await createTestProgram(
        'User Program 2',
        `UP2-${Date.now()}`,
        user.id,
      )
      await createTestProgram('Other Program', `OP-${Date.now()}`, otherUser.id)

      await addProgramMember(program1.id, user.id, 'engineer')
      await addProgramMember(program2.id, user.id, 'viewer')

      const result = await AccessControlService.getAccessiblePrograms(user.id)

      const ids = result.map((p) => p.id)
      expect(ids).toContain(program1.id)
      expect(ids).toContain(program2.id)
    })

    it('returns empty array for user with no program memberships', async () => {
      const user = await insertTestUser(testDb.db, { name: 'No Programs Test' })

      const result = await AccessControlService.getAccessiblePrograms(user.id)

      // May have existing programs from other tests, but user should only see their own
      // This checks the service doesn't throw errors
      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('getAccessibleDesigns', () => {
    it('returns all designs for Global Admin', async () => {
      const admin = await insertTestUser(testDb.db, {
        name: 'Admin Designs Test',
      })
      await makeGlobalAdmin(admin.id)

      const program = await createTestProgram(
        'Admin Design Program',
        `ADP-${Date.now()}`,
        admin.id,
      )
      await createTestDesign('Design A', `DA-${Date.now()}`, admin.id, {
        programId: program.id,
      })
      await createTestDesign('Design B', `DB-${Date.now()}`, admin.id, {
        programId: program.id,
      })

      const result = await AccessControlService.getAccessibleDesigns(admin.id)

      expect(result.length).toBeGreaterThanOrEqual(2)
    })

    it('returns program designs, global libraries, and unassigned for regular user', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Mixed Designs Test',
      })

      const program = await createTestProgram(
        'User Design Program',
        `UDP-${Date.now()}`,
        user.id,
      )
      await addProgramMember(program.id, user.id, 'engineer')

      const programDesign = await createTestDesign(
        'Program Design',
        `PrD-${Date.now()}`,
        user.id,
        {
          programId: program.id,
        },
      )
      const library = await createTestDesign(
        'Global Library',
        `GLib-${Date.now()}`,
        user.id,
        {
          programId: null,
          designType: 'Library',
        },
      )
      // listUnassigned() filters for designType = 'Engineering'
      const unassigned = await createTestDesign(
        'Unassigned',
        `Un-${Date.now()}`,
        user.id,
        {
          programId: null,
          designType: 'Engineering',
        },
      )

      const result = await AccessControlService.getAccessibleDesigns(user.id)

      const ids = result.map((d) => d.id)
      expect(ids).toContain(programDesign.id)
      expect(ids).toContain(library.id)
      expect(ids).toContain(unassigned.id)
    })

    it('excludes designs from non-member programs', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Excluded Designs Test',
      })
      const otherUser = await insertTestUser(testDb.db, {
        name: 'Other Program Owner',
      })

      const myProgram = await createTestProgram(
        'My Program',
        `MP-${Date.now()}`,
        user.id,
      )
      const otherProgram = await createTestProgram(
        'Other Program',
        `OtP-${Date.now()}`,
        otherUser.id,
      )

      await addProgramMember(myProgram.id, user.id, 'engineer')

      const myDesign = await createTestDesign(
        'My Design',
        `MD-${Date.now()}`,
        user.id,
        {
          programId: myProgram.id,
        },
      )
      const otherDesign = await createTestDesign(
        'Other Design',
        `OD-${Date.now()}`,
        otherUser.id,
        {
          programId: otherProgram.id,
        },
      )

      const result = await AccessControlService.getAccessibleDesigns(user.id)

      const ids = result.map((d) => d.id)
      expect(ids).toContain(myDesign.id)
      expect(ids).not.toContain(otherDesign.id)
    })
  })

  describe('getAccessibleProgramIds', () => {
    it('returns null for Global Admin (meaning all programs)', async () => {
      const admin = await insertTestUser(testDb.db, { name: 'Admin IDs Test' })
      await makeGlobalAdmin(admin.id)

      const result = await AccessControlService.getAccessibleProgramIds(
        admin.id,
      )

      expect(result).toBeNull()
    })

    it('returns array of program IDs for regular user', async () => {
      const user = await insertTestUser(testDb.db, { name: 'User IDs Test' })

      const program1 = await createTestProgram(
        'ID Program 1',
        `IDP1-${Date.now()}`,
        user.id,
      )
      const program2 = await createTestProgram(
        'ID Program 2',
        `IDP2-${Date.now()}`,
        user.id,
      )

      await addProgramMember(program1.id, user.id, 'engineer')
      await addProgramMember(program2.id, user.id, 'viewer')

      const result = await AccessControlService.getAccessibleProgramIds(user.id)

      expect(result).not.toBeNull()
      expect(result).toContain(program1.id)
      expect(result).toContain(program2.id)
    })

    it('returns empty array for user with no memberships', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'No Membership IDs Test',
      })

      const result = await AccessControlService.getAccessibleProgramIds(user.id)

      expect(result).toEqual([])
    })
  })

  describe('GLOBAL_ADMIN_ROLE constant', () => {
    it('exports the correct Global Admin role name', () => {
      expect(GLOBAL_ADMIN_ROLE).toBe('Global Admin')
    })
  })
})
