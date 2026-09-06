// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Product variants: validation and resolution over a configurable part.
 *
 * A configurable part carries an option model (families, values,
 * constraints) and named makes on its own version; its BOM lines carry
 * option conditions. This service answers three questions:
 *
 * - Is a set of selections valid for this part? (`validateSelections`)
 * - Is the part's variant data self-consistent? (`lint`)
 * - May this option-model or makes write go ahead? (`assertPartVariantWrite`)
 *
 * Everything here reads through the ordinary item and relationship services,
 * so branch context, version ownership and access rules are theirs.
 *
 * See docs/proposals/product-variants.md.
 */

import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db'
import { itemRelationships, items, parts } from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import {
  conditionMatches,
  findUndeclared,
  formatOptionText,
  makesSchema,
  optionModelSchema,
  validateSelectionsAgainst,
} from '../types/variants'
import type {
  Make,
  OptionCondition,
  OptionModel,
  SelectionIssue,
} from '../types/variants'
import type { Part } from '../items/types/part'

type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]

export interface SelectionValidation {
  /** True when the part is configurable and no `error` issue was found. */
  valid: boolean
  errors: Array<SelectionIssue>
  warnings: Array<SelectionIssue>
}

export type LintCode =
  | 'no_option_model'
  | 'line_undeclared'
  | 'value_unused'
  | 'make_invalid'
  | 'child_family_unset'

export interface LintFinding {
  code: LintCode
  severity: 'error' | 'warning'
  message: string
  /** The BOM relationship a finding is about, when it is about one. */
  relationshipId?: string
  /** The make a finding is about, when it is about one. */
  makeCode?: string
  family?: string
  value?: string
}

/** One line of a resolved BOM: the child as a tree node, with the condition that admitted it. */
export interface ResolvedBomNode {
  itemId: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  designId: string | null
  relationshipId: string
  quantity: number | null
  findNumber: number | null
  referenceDesignator: string | null
  /** The condition on the parent's line; null for a fixed line. */
  admittedBy: OptionCondition | null
  children: Array<ResolvedBomNode>
}

export interface ResolvedBom {
  root: {
    itemId: string
    itemNumber: string
    name: string | null
    revision: string
  }
  selections: Record<string, string>
  validation: SelectionValidation
  children: Array<ResolvedBomNode>
  /** Lines the selections did not admit, counted for the summary. */
  droppedLines: number
  /** Problems below the root: a child model the flat map cannot satisfy. */
  findings: Array<{ itemNumber: string; message: string }>
}

const MAX_RESOLVE_DEPTH = 15

export class VariantService {
  /**
   * Resolve a configuration against a part's 150 % BOM: keep every fixed line
   * and every line whose condition the selections satisfy, recursively, with
   * the same flat selection map at every level (option family codes are a
   * design-wide vocabulary by convention; `lint` warns when a child needs a
   * family the root never sets).
   *
   * Reads the structure in the given branch context, so a condition edited on
   * an ECO branch resolves differently there than on main.
   */
  static async resolve(
    itemId: string,
    selections: Record<string, string>,
    options?: { branchId?: string },
  ): Promise<ResolvedBom> {
    const { ItemService } = await import('../items/services/ItemService')
    const { ItemRelationshipService } =
      await import('../items/services/ItemRelationshipService')

    const root = (await ItemService.findById(itemId)) as Part | null
    if (!root) throw new NotFoundError('Part', itemId)

    const validation = await this.validateSelections(itemId, selections)
    const findings: Array<{ itemNumber: string; message: string }> = []
    let droppedLines = 0

    const linesOf = (id: string) =>
      options?.branchId
        ? ItemRelationshipService.getRelationshipsWithDetailsForBranch(
            id,
            options.branchId,
            'BOM',
          )
        : ItemRelationshipService.getRelationshipsWithDetails(id, 'BOM')

    const walk = async (
      parentId: string,
      depth: number,
      path: Set<string>,
    ): Promise<Array<ResolvedBomNode>> => {
      if (depth > MAX_RESOLVE_DEPTH) return []
      const lines = await linesOf(parentId)
      const kept: Array<ResolvedBomNode> = []
      for (const line of lines) {
        const child = line.targetItem as
          (Part & { masterId: string }) | null | undefined
        if (!child) continue
        if (!conditionMatches(line.option, selections)) {
          droppedLines++
          continue
        }
        // A configurable child validates the same map against its own model,
        // seeing only the families it declares: the map is design-wide, so
        // a family the child never heard of is not its concern.
        if (child.optionModel) {
          const childModel = child.optionModel
          const known = Object.fromEntries(
            Object.entries(selections).filter(([family]) =>
              childModel.families.some((f) => f.code === family),
            ),
          )
          for (const issue of validateSelectionsAgainst(childModel, known)) {
            if (issue.severity === 'error') {
              findings.push({
                itemNumber: child.itemNumber ?? '',
                message: issue.message,
              })
            }
          }
        }
        const childMaster = child.masterId
        const children = path.has(childMaster)
          ? [] // cycle guard, by master as the ancestor walk does
          : await walk(child.id!, depth + 1, new Set([...path, childMaster]))
        kept.push({
          itemId: child.id!,
          masterId: childMaster,
          itemNumber: child.itemNumber ?? '',
          name: child.name ?? null,
          revision: child.revision ?? '',
          state: child.state ?? '',
          itemType: child.itemType,
          designId: child.designId,
          relationshipId: line.id,
          quantity: line.quantity ? Number(line.quantity) : null,
          findNumber: line.findNumber ?? null,
          referenceDesignator: line.referenceDesignator ?? null,
          admittedBy: line.option,
          children,
        })
      }
      return kept
    }

    const children = await walk(
      itemId,
      1,
      new Set([(root as Part & { masterId: string }).masterId]),
    )

    return {
      root: {
        itemId,
        itemNumber: root.itemNumber ?? '',
        name: root.name ?? null,
        revision: root.revision ?? '',
      },
      selections,
      validation,
      children,
      droppedLines,
      findings,
    }
  }

  /**
   * Check selections against a part's option model. A part with no model is
   * not configurable and every selection set is an error for it.
   */
  static async validateSelections(
    itemId: string,
    selections: Record<string, string>,
    tx?: TransactionClient,
  ): Promise<SelectionValidation> {
    const model = await this.loadModel(itemId, tx)
    if (!model) {
      return {
        valid: false,
        errors: [
          {
            severity: 'error',
            message:
              'This part has no option model, so it cannot be configured',
          },
        ],
        warnings: [],
      }
    }
    return this.splitIssues(validateSelectionsAgainst(model, selections))
  }

  /**
   * Self-consistency of a part's variant data: every conditioned line names
   * declared families and values (the write guard makes this a safety net),
   * every declared value is used somewhere, every make is complete and
   * constraint-valid, and every configurable child's required families are
   * ones this part's model can set.
   */
  static async lint(
    itemId: string,
    options?: { branchId?: string },
  ): Promise<Array<LintFinding>> {
    const { ItemService } = await import('../items/services/ItemService')
    const { ItemRelationshipService } =
      await import('../items/services/ItemRelationshipService')

    const part = (await ItemService.findById(itemId)) as Part | null
    if (!part) throw new NotFoundError('Part', itemId)

    const model = part.optionModel ?? null
    const makes = part.makes ?? []
    const findings: Array<LintFinding> = []

    const lines = options?.branchId
      ? await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
          itemId,
          options.branchId,
          'BOM',
        )
      : await ItemRelationshipService.getRelationshipsWithDetails(itemId, 'BOM')

    const conditioned = lines.filter((line) => line.option)

    if (!model) {
      if (conditioned.length > 0) {
        findings.push({
          code: 'no_option_model',
          severity: 'error',
          message: `${conditioned.length} BOM line(s) carry option conditions but the part has no option model`,
        })
      }
      return findings
    }

    // Lines that name something the model no longer declares.
    for (const line of conditioned) {
      const problem = findUndeclared(model, line.option!)
      if (problem) {
        findings.push({
          code: 'line_undeclared',
          severity: 'error',
          message: `${line.targetItem?.itemNumber ?? line.targetId}: ${problem}`,
          relationshipId: line.id,
        })
      }
    }

    // Declared values nothing uses. A warning: harmless, but usually a typo
    // or an option that was meant to get a line.
    const used = new Set<string>()
    const noteCondition = (condition: {
      all: Array<{ family: string; values: Array<string> }>
    }) => {
      for (const entry of condition.all) {
        for (const value of entry.values) used.add(`${entry.family}=${value}`)
      }
    }
    for (const line of conditioned) noteCondition(line.option!)
    for (const constraint of model.constraints) {
      noteCondition(constraint.when)
      noteCondition(constraint.require)
    }
    for (const make of makes) {
      for (const [family, value] of Object.entries(make.selections)) {
        used.add(`${family}=${value}`)
      }
    }
    for (const family of model.families) {
      for (const value of family.values) {
        if (!used.has(`${family.code}=${value.code}`)) {
          findings.push({
            code: 'value_unused',
            severity: 'warning',
            message: `"${family.name}: ${value.label}" is declared but no BOM line, constraint or make uses it`,
            family: family.code,
            value: value.code,
          })
        }
      }
    }

    // Makes must be complete and consistent.
    for (const make of makes) {
      for (const issue of validateSelectionsAgainst(model, make.selections)) {
        if (issue.severity !== 'error') continue
        findings.push({
          code: 'make_invalid',
          severity: 'error',
          message: `Make ${make.code}: ${issue.message}`,
          makeCode: make.code,
          family: issue.family,
        })
      }
    }

    // A configurable child reads the same flat selection map. A required
    // family it declares that this part never sets cannot be satisfied from
    // here, so every configuration of this part fails on that child.
    const declared = new Set(model.families.map((f) => f.code))
    for (const line of lines) {
      const child = line.targetItem as Part | null | undefined
      const childModel = child?.optionModel
      if (!childModel) continue
      for (const family of childModel.families) {
        if (family.required && !declared.has(family.code)) {
          findings.push({
            code: 'child_family_unset',
            severity: 'warning',
            message: `${child.itemNumber} requires option family "${family.code}", which this part does not declare`,
            relationshipId: line.id,
            family: family.code,
          })
        }
      }
    }

    return findings
  }

  /**
   * Guard for `ItemService.update` on a Part: the option model and makes
   * being written must keep every conditioned BOM line of this version and
   * every make resolvable. Returns the canonical values to store.
   */
  static async assertPartVariantWrite(
    currentId: string,
    current: Pick<Part, 'optionModel' | 'makes'>,
    data: Pick<Part, 'optionModel' | 'makes'>,
    tx?: TransactionClient,
  ): Promise<Pick<Part, 'optionModel' | 'makes'>> {
    const executor = tx ?? db

    const nextModel: OptionModel | null =
      data.optionModel === undefined
        ? (current.optionModel ?? null)
        : data.optionModel === null
          ? null
          : optionModelSchema.parse(data.optionModel)
    const nextMakes: Array<Make> | null =
      data.makes === undefined
        ? (current.makes ?? null)
        : data.makes === null
          ? null
          : makesSchema.parse(data.makes)

    const conditioned = await executor
      .select({
        id: itemRelationships.id,
        option: itemRelationships.option,
        childNumber: items.itemNumber,
      })
      .from(itemRelationships)
      .innerJoin(items, eq(items.id, itemRelationships.targetId))
      .where(
        and(
          eq(itemRelationships.sourceId, currentId),
          eq(itemRelationships.relationshipType, 'BOM'),
          isNotNull(itemRelationships.option),
        ),
      )

    const fieldErrors: Array<{ field: string; message: string; code: string }> =
      []

    if (!nextModel) {
      if (conditioned.length > 0) {
        fieldErrors.push({
          field: 'optionModel',
          message: `Cannot remove the option model while ${conditioned.length} BOM line(s) carry option conditions`,
          code: 'OPTION_MODEL_IN_USE',
        })
      }
      if (nextMakes && nextMakes.length > 0) {
        fieldErrors.push({
          field: 'makes',
          message: 'A part without an option model cannot have makes',
          code: 'MAKES_WITHOUT_MODEL',
        })
      }
    } else {
      for (const line of conditioned) {
        const problem = findUndeclared(nextModel, line.option!)
        if (problem) {
          fieldErrors.push({
            field: 'optionModel',
            message: `BOM line ${line.childNumber} (${formatOptionText(line.option)}): ${problem}`,
            code: 'OPTION_IN_USE',
          })
        }
      }
      for (const make of nextMakes ?? []) {
        for (const issue of validateSelectionsAgainst(
          nextModel,
          make.selections,
        )) {
          if (issue.severity !== 'error') continue
          fieldErrors.push({
            field: 'makes',
            message: `Make ${make.code}: ${issue.message}`,
            code: 'MAKE_INVALID',
          })
        }
      }
    }

    if (fieldErrors.length > 0) {
      throw new ValidationError(fieldErrors[0]!.message, fieldErrors, {
        operation: 'update',
        itemId: currentId,
      })
    }

    const result: Pick<Part, 'optionModel' | 'makes'> = {}
    if (data.optionModel !== undefined) result.optionModel = nextModel
    if (data.makes !== undefined) result.makes = nextMakes
    return result
  }

  /** A make's selections, by code, on the given part version. */
  static async selectionsForMake(
    itemId: string,
    makeCode: string,
    tx?: TransactionClient,
  ): Promise<Record<string, string>> {
    const [row] = await (tx ?? db)
      .select({ makes: parts.makes })
      .from(parts)
      .where(eq(parts.itemId, itemId))
      .limit(1)
    const make = (row?.makes ?? []).find(
      (m) => m.code.toLowerCase() === makeCode.toLowerCase(),
    )
    if (!make) {
      throw new NotFoundError('Make', makeCode, { itemId })
    }
    return make.selections
  }

  /** True when `condition` admits `selections`; exported for callers that
   * already hold both and do not want the round trip. */
  static matches = conditionMatches

  private static async loadModel(
    itemId: string,
    tx?: TransactionClient,
  ): Promise<OptionModel | null> {
    const [row] = await (tx ?? db)
      .select({ optionModel: parts.optionModel })
      .from(parts)
      .where(eq(parts.itemId, itemId))
      .limit(1)
    if (!row) throw new NotFoundError('Part', itemId)
    return row.optionModel ?? null
  }

  private static splitIssues(
    issues: Array<SelectionIssue>,
  ): SelectionValidation {
    const errors = issues.filter((i) => i.severity === 'error')
    const warnings = issues.filter((i) => i.severity === 'warning')
    return { valid: errors.length === 0, errors, warnings }
  }
}
