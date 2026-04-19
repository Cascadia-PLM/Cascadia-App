/**
 * UsageService Tests
 *
 * Integration tests for the UsageService class.
 * Tests cover the SysML v2 Definition/Usage pattern including:
 * - Usage/definition identification (isUsage, isDefinition)
 * - SysML type mapping (getSysmlType)
 * - Inheritance config retrieval (getInheritanceConfig)
 * - Usage creation (createUsage)
 * - Definition resolution (resolveDefinition)
 * - Usage queries (getUsagesOfDefinition, getUsageCount, getUsageWithInheritance)
 *
 * Run: npm run test -- src/lib/services/UsageService.test.ts
 */

import { randomUUID } from 'node:crypto'
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
import { UsageService } from './UsageService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { documents, items, parts, programs } from '@/lib/db/schema'
import { NotFoundError } from '@/lib/errors'
import '@/lib/items/registerItemTypes.server'

describe('UsageService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    // Create test user
    user = await insertTestUser(testDb.db)

    // Create test program
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Test Program',
        code: `PROG-${Date.now()}`,
        createdBy: user.id,
      })
      .returning()

    programId = program.id

    // Create test design with main branch
    const design = await DesignService.create(
      {
        programId,
        name: 'Test Design',
        code: `DESIGN-${Date.now()}`,
        designType: 'Engineering',
      },
      user.id,
    )

    designId = design.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  // ============================================================================
  // Helper: Insert a definition Part directly into items + parts tables
  // ============================================================================
  async function insertDefinitionPart(overrides?: {
    itemNumber?: string
    name?: string
    material?: string
    weight?: string
    partType?: string
    cost?: string
    costCurrency?: string
    leadTimeDays?: number
  }) {
    const masterId = randomUUID()
    const itemNumber =
      overrides?.itemNumber ??
      `P-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const [item] = await testDb.db
      .insert(items)
      .values({
        masterId,
        itemNumber,
        revision: 'A',
        itemType: 'Part',
        name: overrides?.name ?? 'Test Definition Part',
        state: 'Draft',
        designId,
        sysmlType: 'PartDefinition',
        metamodel: 'cascadia',
        isCurrent: true,
        createdBy: user.id,
        modifiedBy: user.id,
      })
      .returning()

    await testDb.db.insert(parts).values({
      itemId: item.id,
      description: 'A test definition part',
      material: overrides?.material ?? 'Aluminum',
      weight: overrides?.weight ?? '2.500',
      weightUnit: 'kg',
      partType: overrides?.partType ?? 'Manufacture',
      cost: overrides?.cost ?? '50.00',
      costCurrency: overrides?.costCurrency ?? 'USD',
      leadTimeDays: overrides?.leadTimeDays ?? 14,
    })

    return item
  }

  // ============================================================================
  // Helper: Insert a definition Document
  // ============================================================================
  async function insertDefinitionDocument(overrides?: {
    itemNumber?: string
    name?: string
  }) {
    const masterId = randomUUID()
    const itemNumber =
      overrides?.itemNumber ??
      `D-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    const [item] = await testDb.db
      .insert(items)
      .values({
        masterId,
        itemNumber,
        revision: 'A',
        itemType: 'Document',
        name: overrides?.name ?? 'Test Definition Document',
        state: 'Draft',
        designId,
        sysmlType: 'ItemDefinition',
        metamodel: 'cascadia',
        isCurrent: true,
        createdBy: user.id,
        modifiedBy: user.id,
      })
      .returning()

    await testDb.db.insert(documents).values({
      itemId: item.id,
      description: 'A test definition document',
      fileName: 'test.pdf',
      fileSize: 1024,
      mimeType: 'application/pdf',
    })

    return item
  }

  // ============================================================================
  // isUsage() and isDefinition()
  // ============================================================================
  describe('isUsage', () => {
    it('returns true when usageOf is set', () => {
      expect(UsageService.isUsage({ usageOf: randomUUID() })).toBe(true)
    })

    it('returns false when usageOf is null', () => {
      expect(UsageService.isUsage({ usageOf: null })).toBe(false)
    })

    it('returns false when usageOf is undefined', () => {
      expect(UsageService.isUsage({ usageOf: undefined })).toBe(false)
    })

    it('returns false when usageOf is not present', () => {
      expect(UsageService.isUsage({})).toBe(false)
    })
  })

  describe('isDefinition', () => {
    it('returns true when usageOf is null', () => {
      expect(UsageService.isDefinition({ usageOf: null })).toBe(true)
    })

    it('returns true when usageOf is undefined', () => {
      expect(UsageService.isDefinition({ usageOf: undefined })).toBe(true)
    })

    it('returns true when usageOf is not present', () => {
      expect(UsageService.isDefinition({})).toBe(true)
    })

    it('returns false when usageOf is set', () => {
      expect(UsageService.isDefinition({ usageOf: randomUUID() })).toBe(false)
    })
  })

  // ============================================================================
  // getSysmlType()
  // ============================================================================
  describe('getSysmlType', () => {
    it('returns PartDefinition for Part definition', () => {
      expect(UsageService.getSysmlType('Part', false)).toBe('PartDefinition')
    })

    it('returns PartUsage for Part usage', () => {
      expect(UsageService.getSysmlType('Part', true)).toBe('PartUsage')
    })

    it('returns ItemDefinition for Document definition', () => {
      expect(UsageService.getSysmlType('Document', false)).toBe(
        'ItemDefinition',
      )
    })

    it('returns ItemUsage for Document usage', () => {
      expect(UsageService.getSysmlType('Document', true)).toBe('ItemUsage')
    })

    it('returns RequirementDefinition for Requirement definition', () => {
      expect(UsageService.getSysmlType('Requirement', false)).toBe(
        'RequirementDefinition',
      )
    })

    it('returns RequirementUsage for Requirement usage', () => {
      expect(UsageService.getSysmlType('Requirement', true)).toBe(
        'RequirementUsage',
      )
    })

    it('returns ActionDefinition for Task definition', () => {
      expect(UsageService.getSysmlType('Task', false)).toBe('ActionDefinition')
    })

    it('returns ActionUsage for Task usage', () => {
      expect(UsageService.getSysmlType('Task', true)).toBe('ActionUsage')
    })

    it('returns ActionDefinition for TestPlan definition', () => {
      expect(UsageService.getSysmlType('TestPlan', false)).toBe(
        'ActionDefinition',
      )
    })

    it('returns ActionUsage for TestCase usage', () => {
      expect(UsageService.getSysmlType('TestCase', true)).toBe('ActionUsage')
    })

    it('returns null for unknown item type', () => {
      expect(UsageService.getSysmlType('UnknownType', false)).toBeNull()
    })

    it('returns null for empty item type', () => {
      expect(UsageService.getSysmlType('', true)).toBeNull()
    })
  })

  // ============================================================================
  // getInheritanceConfig()
  // ============================================================================
  describe('getInheritanceConfig', () => {
    it('returns Part inheritance config with correct fields', () => {
      const config = UsageService.getInheritanceConfig('Part')

      expect(config.itemType).toBe('Part')
      expect(config.fields.length).toBeGreaterThan(0)

      // Check inherit-mode fields
      const inheritFields = config.fields.filter((f) => f.mode === 'inherit')
      const inheritFieldNames = inheritFields.map((f) => f.fieldName)
      expect(inheritFieldNames).toContain('description')
      expect(inheritFieldNames).toContain('material')
      expect(inheritFieldNames).toContain('weight')
      expect(inheritFieldNames).toContain('weightUnit')

      // Check copy-mode fields
      const copyFields = config.fields.filter((f) => f.mode === 'copy')
      const copyFieldNames = copyFields.map((f) => f.fieldName)
      expect(copyFieldNames).toContain('partType')
      expect(copyFieldNames).toContain('cost')
      expect(copyFieldNames).toContain('costCurrency')
      expect(copyFieldNames).toContain('leadTimeDays')

      // Check usage-only fields
      const usageOnlyFields = config.fields.filter(
        (f) => f.mode === 'usage-only',
      )
      const usageOnlyNames = usageOnlyFields.map((f) => f.fieldName)
      expect(usageOnlyNames).toContain('quantityOnHand')
      expect(usageOnlyNames).toContain('reorderPoint')
      expect(usageOnlyNames).toContain('location')
    })

    it('returns Document inheritance config with all inherit-mode fields', () => {
      const config = UsageService.getInheritanceConfig('Document')

      expect(config.itemType).toBe('Document')
      expect(config.fields.length).toBeGreaterThan(0)

      // All Document fields should be 'inherit' mode
      const allInherit = config.fields.every((f) => f.mode === 'inherit')
      expect(allInherit).toBe(true)

      const fieldNames = config.fields.map((f) => f.fieldName)
      expect(fieldNames).toContain('description')
      expect(fieldNames).toContain('fileId')
      expect(fieldNames).toContain('fileName')
    })

    it('returns Requirement inheritance config with mixed modes', () => {
      const config = UsageService.getInheritanceConfig('Requirement')

      expect(config.itemType).toBe('Requirement')

      // Check inherit fields
      const inheritFields = config.fields.filter((f) => f.mode === 'inherit')
      expect(inheritFields.map((f) => f.fieldName)).toContain('description')
      expect(inheritFields.map((f) => f.fieldName)).toContain('type')
      expect(inheritFields.map((f) => f.fieldName)).toContain(
        'acceptanceCriteria',
      )

      // Check copy fields
      const copyFields = config.fields.filter((f) => f.mode === 'copy')
      expect(copyFields.map((f) => f.fieldName)).toContain('priority')

      // Check usage-only fields
      const usageOnlyFields = config.fields.filter(
        (f) => f.mode === 'usage-only',
      )
      expect(usageOnlyFields.map((f) => f.fieldName)).toContain('status')
      expect(usageOnlyFields.map((f) => f.fieldName)).toContain(
        'verificationStatus',
      )
    })

    it('returns Task inheritance config', () => {
      const config = UsageService.getInheritanceConfig('Task')

      expect(config.itemType).toBe('Task')
      expect(config.fields.length).toBeGreaterThan(0)

      const usageOnlyFields = config.fields.filter(
        (f) => f.mode === 'usage-only',
      )
      expect(usageOnlyFields.map((f) => f.fieldName)).toContain('assignee')
      expect(usageOnlyFields.map((f) => f.fieldName)).toContain('dueDate')
    })

    it('returns empty fields for unknown item type', () => {
      const config = UsageService.getInheritanceConfig('UnknownType')

      expect(config.itemType).toBe('UnknownType')
      expect(config.fields).toEqual([])
    })
  })

  // ============================================================================
  // resolveDefinition()
  // ============================================================================
  describe('resolveDefinition', () => {
    it('returns the item itself when it is a definition (no usageOf)', async () => {
      const definition = await insertDefinitionPart()

      const resolved = await UsageService.resolveDefinition(definition.id)

      expect(resolved).not.toBeNull()
      expect(resolved!.id).toBe(definition.id)
      expect(resolved!.usageOf).toBeNull()
    })

    it('returns null for non-existent item', async () => {
      const resolved = await UsageService.resolveDefinition(randomUUID())

      expect(resolved).toBeNull()
    })

    it('follows usageOf chain to find canonical definition', async () => {
      // Create a definition
      const definition = await insertDefinitionPart({ name: 'Root Definition' })

      // Create a usage pointing to the definition
      const usageMasterId = randomUUID()
      const [usage] = await testDb.db
        .insert(items)
        .values({
          masterId: usageMasterId,
          itemNumber: `P-USAGE-${Date.now()}`,
          revision: '-',
          itemType: 'Part',
          name: 'Usage of Definition',
          state: 'Draft',
          designId,
          usageOf: definition.id,
          sysmlType: 'PartUsage',
          metamodel: 'cascadia',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()

      const resolved = await UsageService.resolveDefinition(usage.id)

      expect(resolved).not.toBeNull()
      expect(resolved!.id).toBe(definition.id)
      expect(resolved!.name).toBe('Root Definition')
    })

    it('follows multi-level usageOf chain recursively', async () => {
      // Create definition -> usage1 -> usage2
      const definition = await insertDefinitionPart({ name: 'Root Definition' })

      // Usage 1 pointing to definition
      const [usage1] = await testDb.db
        .insert(items)
        .values({
          masterId: randomUUID(),
          itemNumber: `P-U1-${Date.now()}`,
          revision: '-',
          itemType: 'Part',
          name: 'First Level Usage',
          state: 'Draft',
          designId,
          usageOf: definition.id,
          sysmlType: 'PartUsage',
          metamodel: 'cascadia',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()

      // Usage 2 pointing to usage1
      const [usage2] = await testDb.db
        .insert(items)
        .values({
          masterId: randomUUID(),
          itemNumber: `P-U2-${Date.now()}`,
          revision: '-',
          itemType: 'Part',
          name: 'Second Level Usage',
          state: 'Draft',
          designId,
          usageOf: usage1.id,
          sysmlType: 'PartUsage',
          metamodel: 'cascadia',
          isCurrent: true,
          createdBy: user.id,
          modifiedBy: user.id,
        })
        .returning()

      const resolved = await UsageService.resolveDefinition(usage2.id)

      expect(resolved).not.toBeNull()
      expect(resolved!.id).toBe(definition.id)
    })

    it('returns null for soft-deleted items', async () => {
      const definition = await insertDefinitionPart()

      // Soft-delete the item
      await testDb.db
        .update(items)
        .set({ isDeleted: true, deletedAt: new Date(), deletedBy: user.id })
        .where(eq(items.id, definition.id))

      const resolved = await UsageService.resolveDefinition(definition.id)

      expect(resolved).toBeNull()
    })
  })

  // ============================================================================
  // createUsage()
  // ============================================================================
  describe('createUsage', () => {
    it('creates a usage item that references a definition', async () => {
      const definition = await insertDefinitionPart({
        name: 'Widget Definition',
        material: 'Steel',
      })

      const result = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
        },
        user.id,
      )

      expect(result.usage).toBeDefined()
      expect(result.definition).toBeDefined()
      expect(result.definition.id).toBe(definition.id)
      expect(result.usage.usageOf).toBe(definition.id)
      expect(result.usage.itemType).toBe('Part')
      expect(result.usage.sysmlType).toBe('PartUsage')
      expect(result.usage.revision).toBe('-')
      expect(result.usage.designId).toBe(designId)
      expect(result.usage.name).toBe('Widget Definition')
    })

    it('copies type-specific data from definition', async () => {
      const definition = await insertDefinitionPart({
        material: 'Titanium',
        weight: '5.000',
        partType: 'Purchase',
        cost: '100.00',
      })

      const result = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
        },
        user.id,
      )

      expect(result.typeData).not.toBeNull()
      // Copy-mode fields should be copied from definition
      expect(result.typeData!.partType).toBe('Purchase')
      expect(result.typeData!.cost).toBe('100.00')
      // Inherit-mode fields are also initially copied
      expect(result.typeData!.material).toBe('Titanium')
      expect(result.typeData!.weight).toBe('5.000')
      // Usage-only fields should be null
      expect(result.typeData!.quantityOnHand).toBeNull()
      expect(result.typeData!.reorderPoint).toBeNull()
      expect(result.typeData!.location).toBeNull()
    })

    it('allows overriding name on usage creation', async () => {
      const definition = await insertDefinitionPart({ name: 'Original Name' })

      const result = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
          overrides: {
            name: 'Custom Usage Name',
          },
        },
        user.id,
      )

      expect(result.usage.name).toBe('Custom Usage Name')
    })

    it('allows overriding itemNumber on usage creation', async () => {
      const definition = await insertDefinitionPart()
      const customNumber = `CUSTOM-${Date.now()}`

      const result = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
          overrides: {
            itemNumber: customNumber,
          },
        },
        user.id,
      )

      expect(result.usage.itemNumber).toBe(customNumber)
    })

    it('throws NotFoundError for non-existent definition', async () => {
      await expect(
        UsageService.createUsage(
          {
            definitionId: randomUUID(),
            targetDesignId: designId,
          },
          user.id,
        ),
      ).rejects.toThrow(NotFoundError)
    })

    it('resolves through usage chain when creating from another usage', async () => {
      const definition = await insertDefinitionPart({
        name: 'Canonical Definition',
      })

      // Create a usage of the definition
      const firstUsage = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
        },
        user.id,
      )

      // Create a second usage referencing the first usage - should resolve to definition
      const secondUsage = await UsageService.createUsage(
        {
          definitionId: firstUsage.usage.id,
          targetDesignId: designId,
          overrides: {
            itemNumber: `P-SECOND-${Date.now()}`,
          },
        },
        user.id,
      )

      // The second usage should point to the original definition, not the first usage
      expect(secondUsage.definition.id).toBe(definition.id)
      expect(secondUsage.usage.usageOf).toBe(definition.id)
    })

    it('creates usage for Document type with correct sysmlType', async () => {
      const definition = await insertDefinitionDocument()

      const result = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
        },
        user.id,
      )

      expect(result.usage.itemType).toBe('Document')
      expect(result.usage.sysmlType).toBe('ItemUsage')
      expect(result.usage.usageOf).toBe(definition.id)
    })
  })

  // ============================================================================
  // getUsagesOfDefinition()
  // ============================================================================
  describe('getUsagesOfDefinition', () => {
    it('returns all usages of a definition', async () => {
      const definition = await insertDefinitionPart()

      // Create 3 usages
      await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
          overrides: { itemNumber: `U1-${Date.now()}` },
        },
        user.id,
      )
      await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
          overrides: { itemNumber: `U2-${Date.now()}` },
        },
        user.id,
      )
      await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
          overrides: { itemNumber: `U3-${Date.now()}` },
        },
        user.id,
      )

      const usages = await UsageService.getUsagesOfDefinition(definition.id)

      expect(usages).toHaveLength(3)
      for (const usage of usages) {
        expect(usage.usageOf).toBe(definition.id)
      }
    })

    it('returns empty array when no usages exist', async () => {
      const definition = await insertDefinitionPart()

      const usages = await UsageService.getUsagesOfDefinition(definition.id)

      expect(usages).toEqual([])
    })

    it('returns empty array for non-existent definition', async () => {
      const usages = await UsageService.getUsagesOfDefinition(randomUUID())

      expect(usages).toEqual([])
    })
  })

  // ============================================================================
  // getUsageCount()
  // ============================================================================
  describe('getUsageCount', () => {
    it('returns correct count of usages', async () => {
      const definition = await insertDefinitionPart()

      // Create 2 usages
      await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
          overrides: { itemNumber: `UC1-${Date.now()}` },
        },
        user.id,
      )
      await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
          overrides: { itemNumber: `UC2-${Date.now()}` },
        },
        user.id,
      )

      const count = await UsageService.getUsageCount(definition.id)

      expect(count).toBe(2)
    })

    it('returns 0 when no usages exist', async () => {
      const definition = await insertDefinitionPart()

      const count = await UsageService.getUsageCount(definition.id)

      expect(count).toBe(0)
    })

    it('returns 0 for non-existent definition', async () => {
      const count = await UsageService.getUsageCount(randomUUID())

      expect(count).toBe(0)
    })
  })

  // ============================================================================
  // getUsageWithInheritance()
  // ============================================================================
  describe('getUsageWithInheritance', () => {
    it('returns usage with inherited fields merged from definition', async () => {
      const definition = await insertDefinitionPart({
        material: 'CarbonFiber',
        weight: '1.200',
        partType: 'Manufacture',
        cost: '200.00',
      })

      const { usage } = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
        },
        user.id,
      )

      const resolved = await UsageService.getUsageWithInheritance(usage.id)

      expect(resolved).not.toBeNull()
      expect(resolved!.definitionId).toBe(definition.id)
      expect(resolved!.fieldSources).toBeDefined()

      // Inherit-mode fields should show 'inherited' source
      expect(resolved!.fieldSources!.material).toBe('inherited')
      expect(resolved!.fieldSources!.weight).toBe('inherited')
      expect(resolved!.fieldSources!.description).toBe('inherited')

      // Copy and usage-only fields should show 'local' source
      expect(resolved!.fieldSources!.partType).toBe('local')
      expect(resolved!.fieldSources!.cost).toBe('local')
      expect(resolved!.fieldSources!.quantityOnHand).toBe('local')
    })

    it('returns null for non-existent usage', async () => {
      const resolved = await UsageService.getUsageWithInheritance(randomUUID())

      expect(resolved).toBeNull()
    })

    it('returns definition as-is when item is not a usage', async () => {
      const definition = await insertDefinitionPart({
        name: 'Self-Referential Definition',
      })

      const resolved = await UsageService.getUsageWithInheritance(definition.id)

      expect(resolved).not.toBeNull()
      // For definitions, definitionId should be the item's own ID
      expect(resolved!.definitionId).toBe(definition.id)
      // No fieldSources for a definition (not a usage)
      expect(resolved!.fieldSources).toBeUndefined()
    })

    it('inherits values from definition for inherit-mode fields', async () => {
      // Create definition with specific material
      const definition = await insertDefinitionPart({
        material: 'Titanium',
        weight: '3.000',
      })

      const { usage } = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
        },
        user.id,
      )

      // Now update the definition's part data to simulate a change
      await testDb.db
        .update(parts)
        .set({ material: 'UpdatedTitanium', weight: '3.500' })
        .where(eq(parts.itemId, definition.id))

      // getUsageWithInheritance should return the updated definition values for inherit fields
      const resolved = await UsageService.getUsageWithInheritance(usage.id)

      expect(resolved).not.toBeNull()
      // Inherit fields should reflect definition's updated values
      expect((resolved as any).material).toBe('UpdatedTitanium')
      expect((resolved as any).weight).toBe('3.500')
    })

    it('uses local values for copy-mode fields even if definition changes', async () => {
      const definition = await insertDefinitionPart({
        partType: 'Manufacture',
        cost: '75.00',
      })

      const { usage } = await UsageService.createUsage(
        {
          definitionId: definition.id,
          targetDesignId: designId,
        },
        user.id,
      )

      // Update the definition's cost (copy-mode field)
      await testDb.db
        .update(parts)
        .set({ partType: 'Purchase', cost: '150.00' })
        .where(eq(parts.itemId, definition.id))

      const resolved = await UsageService.getUsageWithInheritance(usage.id)

      expect(resolved).not.toBeNull()
      // Copy fields should retain usage's own copied values, not the updated definition
      expect((resolved as any).partType).toBe('Manufacture')
      expect((resolved as any).cost).toBe('75.00')
    })
  })
})
