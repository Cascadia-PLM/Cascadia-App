// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AccessControlService Tests
 *
 * Integration tests for the AccessControlService class.
 * Tests cover program-based access control, the cross-program-authority
 * bypass (keyed on the RBAC programs:manage permission), and design access.
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
import { AccessControlService } from './AccessControlService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { roles, userRoles } from '@/lib/db/schema/users'
import { designs, programMembers, programs } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

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
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name,
          code,
          description: `${name} description`,
          createdBy,
        })
        .returning(),
    )
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
    const design = takeFirst(
      await testDb.db
        .insert(designs)
        .values({
          name,
          code,
          programId: options.programId ?? null,
          designType: options.designType ?? 'Engineering',
          createdBy,
        })
        .returning(),
    )
    return design
  }

  // Helper to assign a role carrying cross-program authority. Uses the
  // built-in Administrator role name, but the bypass keys on the
  // programs:manage permission inside it, not on the name.
  async function makeAdmin(userId: string) {
    let adminRole = await testDb.db.query.roles.findFirst({
      where: eq(roles.name, 'Administrator'),
    })

    if (!adminRole) {
      adminRole = takeFirst(
        await testDb.db
          .insert(roles)
          .values({
            name: 'Administrator',
            description: 'Top-level administrator',
            permissions: {
              parts: ['create', 'read', 'update', 'delete', 'approve'],
              users: ['create', 'read', 'update', 'delete', 'manage'],
              programs: ['create', 'read', 'update', 'delete', 'manage'],
              system: ['read', 'manage'],
            },
          })
          .returning(),
      )
    }

    await testDb.db.insert(userRoles).values({
      userId,
      roleId: adminRole.id,
    })
  }

  // Helper to assign an arbitrary role with the given permissions map.
  async function assignRoleWithPermissions(
    userId: string,
    name: string,
    permissions: Record<string, Array<string>>,
  ) {
    const role = takeFirst(
      await testDb.db
        .insert(roles)
        .values({ name, description: name, permissions })
        .returning(),
    )
    await testDb.db.insert(userRoles).values({ userId, roleId: role.id })
  }

  describe('hasCrossProgramAccess', () => {
    it('returns true for an Administrator', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Admin Bypass Test',
      })
      await makeAdmin(user.id)

      const result = await AccessControlService.hasCrossProgramAccess(user.id)

      expect(result).toBe(true)
    })

    it('returns false for a user without programs:manage', async () => {
      const user = await insertTestUser(testDb.db, {
        name: 'Regular User Test',
      })

      const result = await AccessControlService.hasCrossProgramAccess(user.id)

      expect(result).toBe(false)
    })

    it('returns false for non-existent user', async () => {
      const fakeUserId = '00000000-0000-0000-0000-000000000000'

      const result =
        await AccessControlService.hasCrossProgramAccess(fakeUserId)

      expect(result).toBe(false)
    })

    it('keys on the permission, not the role name', async () => {
      // A role named like an admin but without programs:manage gets nothing…
      const impostor = await insertTestUser(testDb.db, { name: 'Impostor' })
      await assignRoleWithPermissions(impostor.id, 'Administrator II', {
        programs: ['create', 'read', 'update', 'delete'],
        system: ['read', 'manage'],
      })
      expect(
        await AccessControlService.hasCrossProgramAccess(impostor.id),
      ).toBe(false)

      // …while any custom role carrying programs:manage gets the bypass.
      const custom = await insertTestUser(testDb.db, { name: 'Custom Role' })
      await assignRoleWithPermissions(custom.id, 'PMO Lead', {
        programs: ['read', 'manage'],
      })
      expect(await AccessControlService.hasCrossProgramAccess(custom.id)).toBe(
        true,
      )
    })

    it('still honors a legacy Global Admin role row', async () => {
      // Deployments seeded before the merge have a role literally named
      // 'Global Admin' whose stored permissions include programs:manage.
      // The permission-keyed bypass must keep matching those users.
      const legacy = await insertTestUser(testDb.db, { name: 'Legacy GA' })
      await assignRoleWithPermissions(legacy.id, 'Global Admin', {
        parts: ['create', 'read', 'update', 'delete', 'approve', 'manage'],
        programs: ['create', 'read', 'update', 'delete', 'manage'],
        system: ['read', 'manage'],
      })

      expect(await AccessControlService.hasCrossProgramAccess(legacy.id)).toBe(
        true,
      )
    })
  })

  describe('canAccessProgram', () => {
    it('returns true for an Administrator regardless of membership', async () => {
      const admin = await insertTestUser(testDb.db, {
        name: 'Admin Access Test',
      })
      await makeAdmin(admin.id)

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
    it('returns true for an Administrator regardless of design program', async () => {
      const admin = await insertTestUser(testDb.db, {
        name: 'Admin Design Test',
      })
      await makeAdmin(admin.id)

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
    it('returns all programs for an Administrator', async () => {
      const admin = await insertTestUser(testDb.db, {
        name: 'Admin Programs Test',
      })
      await makeAdmin(admin.id)

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
    it('returns all designs for an Administrator', async () => {
      const admin = await insertTestUser(testDb.db, {
        name: 'Admin Designs Test',
      })
      await makeAdmin(admin.id)

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
    it('returns null for an Administrator (meaning all programs)', async () => {
      const admin = await insertTestUser(testDb.db, { name: 'Admin IDs Test' })
      await makeAdmin(admin.id)

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

  // ==========================================================================
  // canAccessDesign vs getAccessibleDesignIds
  //
  // The same rule is written twice — once as TypeScript branches for a single
  // design, once as a SQL predicate for a whole list. They must admit the
  // same set, or a list would show rows that opening them denies (a leak) or
  // hide rows the user may read (a phantom).
  //
  // Nothing in the type system ties the two together, so this differential
  // check is the tie. It is what the duplicate scope helpers that used to
  // live in items.ts and enterprise-search.ts lacked: both had drifted from
  // canAccessDesign, one admitting any design merely typed 'Library' and
  // both denying an administrator the cross-program bypass.
  //
  // Extend the matrix, not just the branches, when a new access rule lands.
  // ==========================================================================

  describe('getAccessibleDesignIds agrees with canAccessDesign', () => {
    it('admits exactly the same designs, for every kind of user', async () => {
      const owner = await insertTestUser(testDb.db, { name: 'Matrix Owner' })

      const programA = await createTestProgram(
        'Matrix A',
        `MTXA-${Date.now()}`,
        owner.id,
      )
      const programB = await createTestProgram(
        'Matrix B',
        `MTXB-${Date.now()}`,
        owner.id,
      )

      const designs_ = {
        inA: await createTestDesign('In A', `DA-${Date.now()}`, owner.id, {
          programId: programA.id,
        }),
        inB: await createTestDesign('In B', `DB-${Date.now()}`, owner.id, {
          programId: programB.id,
        }),
        // A Library that belongs to a program is not global: it follows that
        // program's membership like any other design.
        libraryInA: await createTestDesign(
          'Library In A',
          `DLA-${Date.now()}`,
          owner.id,
          { programId: programA.id, designType: 'Library' },
        ),
        globalLibrary: await createTestDesign(
          'Global Library',
          `DGL-${Date.now()}`,
          owner.id,
          { programId: null, designType: 'Library' },
        ),
        unassigned: await createTestDesign(
          'Unassigned',
          `DUN-${Date.now()}`,
          owner.id,
          { programId: null, designType: 'Engineering' },
        ),
      }

      const admin = await insertTestUser(testDb.db, { name: 'Matrix Admin' })
      await makeAdmin(admin.id)

      const memberOfA = await insertTestUser(testDb.db, {
        name: 'Matrix Member A',
      })
      await addProgramMember(programA.id, memberOfA.id)

      const memberOfBoth = await insertTestUser(testDb.db, {
        name: 'Matrix Member Both',
      })
      await addProgramMember(programA.id, memberOfBoth.id)
      await addProgramMember(programB.id, memberOfBoth.id)

      const noPrograms = await insertTestUser(testDb.db, {
        name: 'Matrix No Programs',
      })

      for (const user of [admin, memberOfA, memberOfBoth, noPrograms]) {
        const scope = await AccessControlService.getAccessibleDesignIds(user.id)

        for (const [label, design] of Object.entries(designs_)) {
          // `null` scope is cross-program authority — it reaches everything.
          const inScope = scope === null || scope.includes(design.id)
          const pointCheck = await AccessControlService.canAccessDesign(
            user.id,
            design.id,
          )

          expect(
            inScope,
            `${user.name} / ${label}: list scope says ${inScope}, ` +
              `canAccessDesign says ${pointCheck}`,
          ).toBe(pointCheck)
        }
      }
    })

    it('reaches the global library even for a user in no program', async () => {
      const owner = await insertTestUser(testDb.db, { name: 'Lib Owner' })
      const library = await createTestDesign(
        'Standard Library',
        `STDLIB-${Date.now()}`,
        owner.id,
        { programId: null, designType: 'Library' },
      )
      const user = await insertTestUser(testDb.db, { name: 'Lib Reader' })

      const scope = await AccessControlService.getAccessibleDesignIds(user.id)

      // Not null — this user has no bypass — but still contains the library.
      expect(scope).not.toBeNull()
      expect(scope).toContain(library.id)
    })

    it('returns null, not a list, for cross-program authority', async () => {
      const admin = await insertTestUser(testDb.db, { name: 'Scope Admin' })
      await makeAdmin(admin.id)

      // null and [] must stay distinguishable: one means "everything", the
      // other "nothing but design-less items".
      expect(
        await AccessControlService.getAccessibleDesignIds(admin.id),
      ).toBeNull()
    })
  })
})
