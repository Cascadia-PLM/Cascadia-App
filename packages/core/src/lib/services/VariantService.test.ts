// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Product variants: the option model and the BOM lines that reference it
 * must stay consistent through every write, and a make must always be a
 * complete, constraint-valid configuration.
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
import { VariantService } from './VariantService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Part } from '@/lib/items/types/part'
import type { OptionModel } from '@/lib/types/variants'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { insertTestPart } from '@/__tests__/fixtures/items'
import { ItemService } from '@/lib/items/services/ItemService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { parts, programs } from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
import { ValidationError } from '@/lib/errors'

import '@/lib/items/registerItemTypes.server'

const model: OptionModel = {
  families: [
    {
      code: 'color',
      name: 'Colour',
      required: true,
      values: [
        { code: 'black', label: 'Black' },
        { code: 'white', label: 'White' },
      ],
    },
    {
      code: 'display',
      name: 'Display',
      required: true,
      values: [
        { code: 'yes', label: 'Yes' },
        { code: 'no', label: 'No' },
      ],
    },
  ],
  constraints: [],
}

describe('VariantService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)
    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    // An administrator: `ItemService.update` checks design access, and the
    // guard under test sits behind it.
    user = (await insertTestUserWithRole(testDb.db, 'Administrator')).user
    const suffix =
      `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Variants',
          code: `PROG-${suffix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Touch switch',
        code: `TS-${suffix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function configurablePart() {
    const created = await insertTestPart(testDb.db, designId, user.id)
    await testDb.db
      .update(parts)
      .set({ optionModel: model })
      .where(eq(parts.itemId, created.item.id))
    return created.item
  }

  async function addLine(
    parentId: string,
    option: { all: Array<{ family: string; values: Array<string> }> } | null,
  ) {
    const child = await insertTestPart(testDb.db, designId, user.id)
    return ItemRelationshipService.addRelationship(
      parentId,
      child.item.id,
      'BOM',
      user.id,
      { quantity: '1', option },
      { bypassEditGuard: true },
    )
  }

  describe('validateSelections', () => {
    it('reports an unconfigurable part as invalid', async () => {
      const plain = await insertTestPart(testDb.db, designId, user.id)
      const result = await VariantService.validateSelections(plain.item.id, {})
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
    })

    it('validates against the part model', async () => {
      const part = await configurablePart()
      expect(
        (
          await VariantService.validateSelections(part.id, {
            color: 'black',
            display: 'yes',
          })
        ).valid,
      ).toBe(true)
      const missing = await VariantService.validateSelections(part.id, {
        color: 'black',
      })
      expect(missing.valid).toBe(false)
      expect(missing.errors[0]?.family).toBe('display')
    })
  })

  describe('option model writes', () => {
    it('refuses to remove a family a BOM line still uses', async () => {
      const part = await configurablePart()
      await addLine(part.id, { all: [{ family: 'display', values: ['yes'] }] })

      const withoutDisplay: OptionModel = {
        families: model.families.filter((f) => f.code !== 'display'),
        constraints: [],
      }
      await expect(
        ItemService.update<Part>(
          part.id,
          { optionModel: withoutDisplay },
          user.id,
          { bypassBranchProtection: true },
        ),
      ).rejects.toBeInstanceOf(ValidationError)

      // Removing an unused value is fine.
      const trimmed: OptionModel = {
        families: model.families.map((f) =>
          f.code === 'display'
            ? { ...f, values: f.values.filter((v) => v.code === 'yes') }
            : f,
        ),
        constraints: [],
      }
      const updated = await ItemService.update<Part>(
        part.id,
        { optionModel: trimmed },
        user.id,
        { bypassBranchProtection: true },
      )
      expect(
        updated.optionModel?.families.find((f) => f.code === 'display')?.values,
      ).toHaveLength(1)
    })

    it('refuses to clear the model while conditioned lines exist', async () => {
      const part = await configurablePart()
      await addLine(part.id, { all: [{ family: 'color', values: ['black'] }] })
      await expect(
        ItemService.update<Part>(part.id, { optionModel: null }, user.id, {
          bypassBranchProtection: true,
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('stores makes only when they are complete and declared', async () => {
      const part = await configurablePart()
      await expect(
        ItemService.update<Part>(
          part.id,
          {
            makes: [
              {
                code: 'MK1',
                name: 'black',
                selections: { color: 'black' },
                active: true,
              },
            ],
          },
          user.id,
          { bypassBranchProtection: true },
        ),
      ).rejects.toBeInstanceOf(ValidationError)

      const updated = await ItemService.update<Part>(
        part.id,
        {
          makes: [
            {
              code: 'MK1',
              name: 'black',
              selections: { color: 'black', display: 'yes' },
              active: true,
            },
          ],
        },
        user.id,
        { bypassBranchProtection: true },
      )
      expect(updated.makes?.[0]?.code).toBe('MK1')
      expect(await VariantService.selectionsForMake(part.id, 'mk1')).toEqual({
        color: 'black',
        display: 'yes',
      })
    })
  })

  describe('resolve', () => {
    const colourOnly = (code: string) => ({
      all: [{ family: 'color', values: [code] }],
    })

    async function partWithModel(optionModel: OptionModel) {
      const created = await insertTestPart(testDb.db, designId, user.id)
      await testDb.db
        .update(parts)
        .set({ optionModel })
        .where(eq(parts.itemId, created.item.id))
      return created.item
    }

    async function line(
      parentId: string,
      childId: string,
      option: { all: Array<{ family: string; values: Array<string> }> } | null,
      quantity = '1',
    ) {
      return ItemRelationshipService.addRelationship(
        parentId,
        childId,
        'BOM',
        user.id,
        { quantity, option },
        { bypassEditGuard: true },
      )
    }

    it('keeps fixed lines, admits matching lines, drops the rest, and recurses with the flat map', async () => {
      const parent = await configurablePart()
      const pcb = await insertTestPart(testDb.db, designId, user.id)
      const housingBlack = await insertTestPart(testDb.db, designId, user.id)
      const housingWhite = await insertTestPart(testDb.db, designId, user.id)
      // The board reads the same `color` family from the same flat map.
      const board = await partWithModel({
        families: [model.families[0]!],
        constraints: [],
      })
      const ledBlack = await insertTestPart(testDb.db, designId, user.id)
      const ledWhite = await insertTestPart(testDb.db, designId, user.id)

      await line(parent.id, pcb.item.id, null)
      await line(parent.id, housingBlack.item.id, colourOnly('black'))
      await line(parent.id, housingWhite.item.id, colourOnly('white'), '2')
      await line(parent.id, board.id, null)
      await line(board.id, ledBlack.item.id, colourOnly('black'), '4')
      await line(board.id, ledWhite.item.id, colourOnly('white'), '4')

      const resolved = await VariantService.resolve(parent.id, {
        color: 'black',
        display: 'yes',
      })

      expect(resolved.validation.valid).toBe(true)
      expect(resolved.findings).toEqual([])
      expect(resolved.droppedLines).toBe(2)

      const childIds = resolved.children.map((c) => c.itemId).sort()
      expect(childIds).toEqual(
        [pcb.item.id, housingBlack.item.id, board.id].sort(),
      )
      const housing = resolved.children.find(
        (c) => c.itemId === housingBlack.item.id,
      )
      expect(housing?.admittedBy).toEqual(colourOnly('black'))
      const boardNode = resolved.children.find((c) => c.itemId === board.id)
      expect(boardNode?.admittedBy).toBeNull()
      expect(boardNode?.children.map((c) => c.itemId)).toEqual([
        ledBlack.item.id,
      ])
      expect(boardNode?.children[0]?.quantity).toBe(4)
    })

    it('reports a configurable child the flat map cannot satisfy', async () => {
      const parent = await configurablePart()
      const board = await partWithModel({
        families: [
          {
            code: 'population',
            name: 'Population',
            required: true,
            values: [{ code: 'a', label: 'A' }],
          },
        ],
        constraints: [],
      })
      await line(parent.id, board.id, null)

      const resolved = await VariantService.resolve(parent.id, {
        color: 'black',
        display: 'yes',
      })
      expect(resolved.children).toHaveLength(1)
      expect(resolved.findings[0]?.itemNumber).toBe(board.itemNumber)
    })

    it('resolves an incomplete configuration to the fixed lines plus what it names', async () => {
      const parent = await configurablePart()
      const pcb = await insertTestPart(testDb.db, designId, user.id)
      const housingBlack = await insertTestPart(testDb.db, designId, user.id)
      await line(parent.id, pcb.item.id, null)
      await line(parent.id, housingBlack.item.id, colourOnly('black'))

      const resolved = await VariantService.resolve(parent.id, {})
      expect(resolved.validation.valid).toBe(false)
      expect(resolved.children.map((c) => c.itemId)).toEqual([pcb.item.id])
      expect(resolved.droppedLines).toBe(1)
    })
  })

  describe('lint', () => {
    it('is quiet for a part with no variant data', async () => {
      const plain = await insertTestPart(testDb.db, designId, user.id)
      expect(await VariantService.lint(plain.item.id)).toEqual([])
    })

    it('warns about unused values and flags an incomplete make', async () => {
      const part = await configurablePart()
      await addLine(part.id, { all: [{ family: 'color', values: ['black'] }] })
      await addLine(part.id, { all: [{ family: 'color', values: ['white'] }] })
      await testDb.db
        .update(parts)
        .set({
          makes: [
            {
              code: 'MK1',
              name: '',
              selections: { color: 'black' },
              active: true,
            },
          ],
        })
        .where(eq(parts.itemId, part.id))

      const findings = await VariantService.lint(part.id)
      const codes = findings.map((f) => f.code)
      // display=yes and display=no are declared but nothing uses them.
      expect(findings.filter((f) => f.code === 'value_unused')).toHaveLength(2)
      expect(codes).toContain('make_invalid')
      expect(codes).not.toContain('line_undeclared')
    })

    it('warns when a configurable child needs a family this part never sets', async () => {
      const parent = await configurablePart()
      const board = await insertTestPart(testDb.db, designId, user.id)
      await testDb.db
        .update(parts)
        .set({
          optionModel: {
            families: [
              {
                code: 'population',
                name: 'Population',
                required: true,
                values: [{ code: 'a', label: 'A' }],
              },
            ],
            constraints: [],
          },
        })
        .where(eq(parts.itemId, board.item.id))
      await ItemRelationshipService.addRelationship(
        parent.id,
        board.item.id,
        'BOM',
        user.id,
        { quantity: '1' },
        { bypassEditGuard: true },
      )

      const findings = await VariantService.lint(parent.id)
      const child = findings.find((f) => f.code === 'child_family_unset')
      expect(child?.family).toBe('population')
    })
  })
})
