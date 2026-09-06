// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Product variants: the shapes shared by BOM lines, parts, the resolver and
 * the UI. No database imports here — this file is bundled into the client.
 *
 * A configurable Part carries an {@link OptionModel}: named option families
 * with value domains, plus constraints between them. Its BOM is a "150 %"
 * BOM: every line is either fixed (`option` null) or carries an
 * {@link OptionCondition} saying which selections admit it. A {@link Make} is
 * a named, complete set of selections stored on the Part. Resolving a set of
 * selections against the BOM keeps the fixed lines plus the lines whose
 * condition the selections satisfy.
 *
 * See docs/proposals/product-variants.md.
 */

import { z } from 'zod'

// ============================================================================
// Conditions
// ============================================================================

/**
 * When a BOM line applies. ALL listed families must match; within one family
 * ANY listed value matches. A family absent from the selections fails.
 *
 * Deliberately tiny: it is what a chip picker builds, it needs no parser, and
 * OR across families is simply a second line.
 */
export interface OptionCondition {
  all: Array<{ family: string; values: Array<string> }>
}

/** Family and value codes: lower-case identifiers, stable across renames. */
export const OPTION_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

const optionCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(50)
  .regex(
    OPTION_CODE_PATTERN,
    'Codes are lower-case letters, digits, "_" and "-", starting with a letter or digit',
  )

/**
 * Put a condition in canonical form: families sorted by code, values sorted
 * and de-duplicated. Two conditions that mean the same thing then serialise
 * identically, which the unique index on `item_relationships.option` and the
 * conflict signature both rely on.
 */
export function normalizeOptionCondition(
  condition: OptionCondition,
): OptionCondition {
  const byFamily = new Map<string, Set<string>>()
  for (const entry of condition.all) {
    const family = entry.family.trim().toLowerCase()
    const set = byFamily.get(family) ?? new Set<string>()
    for (const value of entry.values) {
      const v = value.trim().toLowerCase()
      if (v) set.add(v)
    }
    byFamily.set(family, set)
  }
  return {
    all: [...byFamily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, values]) => ({
        family,
        values: [...values].sort((a, b) => a.localeCompare(b)),
      })),
  }
}

/**
 * Zod contract for a condition as it arrives over the wire. Normalises on the
 * way in, so every stored condition is canonical.
 */
export const optionConditionSchema = z
  .object({
    all: z
      .array(
        z.object({
          family: optionCodeSchema,
          values: z.array(optionCodeSchema).min(1),
        }),
      )
      .min(1),
  })
  .transform(normalizeOptionCondition)
  .refine((c) => c.all.every((e) => e.values.length > 0), {
    message: 'Every family in a condition needs at least one value',
  })

/** Stable string identity of a condition; `''` for a fixed line. */
export function optionConditionKey(
  condition: OptionCondition | null | undefined,
): string {
  if (!condition) return ''
  return JSON.stringify(normalizeOptionCondition(condition))
}

/**
 * Text form used by CSV import/export and shown in tooltips:
 * `color=black; display=yes,no`. Families separated by `;`, values by `,`.
 */
export function formatOptionText(
  condition: OptionCondition | null | undefined,
): string {
  if (!condition) return ''
  return normalizeOptionCondition(condition)
    .all.map((e) => `${e.family}=${e.values.join(',')}`)
    .join('; ')
}

/**
 * Inverse of {@link formatOptionText}. Empty or whitespace text means a fixed
 * line (`null`). Malformed text throws; the import path reports it per row.
 */
export function parseOptionText(text: string): OptionCondition | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const all = trimmed
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((clause) => {
      const eq = clause.indexOf('=')
      if (eq <= 0) {
        throw new Error(
          `Option condition "${clause}" must look like family=value[,value]`,
        )
      }
      const family = clause.slice(0, eq).trim()
      const values = clause
        .slice(eq + 1)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
      if (values.length === 0) {
        throw new Error(`Option condition "${clause}" names no value`)
      }
      return { family, values }
    })
  return optionConditionSchema.parse({ all })
}

/**
 * Does a condition admit these selections? A fixed line (null condition)
 * always does. A family missing from `selections` fails, so an incomplete
 * configuration resolves to the fixed lines plus whatever it does name.
 */
export function conditionMatches(
  condition: OptionCondition | null | undefined,
  selections: Record<string, string>,
): boolean {
  if (!condition) return true
  return condition.all.every((entry) => {
    const selected = selections[entry.family]
    return selected !== undefined && entry.values.includes(selected)
  })
}

// ============================================================================
// Option model and makes (stored on the Part version)
// ============================================================================

export interface OptionValue {
  code: string
  label: string
}

export interface OptionFamily {
  code: string
  name: string
  /** A complete configuration must select a value for a required family. */
  required: boolean
  values: Array<OptionValue>
}

/** If `when` matches, `require` must match too. */
export interface OptionConstraint {
  when: OptionCondition
  require: OptionCondition
  message: string
}

export interface OptionModel {
  families: Array<OptionFamily>
  constraints: Array<OptionConstraint>
}

/** A named, complete set of selections: what the customer calls a make. */
export interface Make {
  code: string
  name: string
  selections: Record<string, string>
  active: boolean
}

export const optionModelSchema = z
  .object({
    families: z
      .array(
        z.object({
          code: optionCodeSchema,
          name: z.string().trim().min(1).max(200),
          required: z.boolean().default(true),
          values: z
            .array(
              z.object({
                code: optionCodeSchema,
                label: z.string().trim().min(1).max(200),
              }),
            )
            .min(1),
        }),
      )
      .default([]),
    constraints: z
      .array(
        z.object({
          when: optionConditionSchema,
          require: optionConditionSchema,
          message: z.string().trim().max(500).default(''),
        }),
      )
      .default([]),
  })
  .superRefine((model, ctx) => {
    const familyCodes = new Set<string>()
    model.families.forEach((family, fi) => {
      if (familyCodes.has(family.code)) {
        ctx.addIssue({
          code: 'custom',
          path: ['families', fi, 'code'],
          message: `Duplicate family code "${family.code}"`,
        })
      }
      familyCodes.add(family.code)
      const valueCodes = new Set<string>()
      family.values.forEach((value, vi) => {
        if (valueCodes.has(value.code)) {
          ctx.addIssue({
            code: 'custom',
            path: ['families', fi, 'values', vi, 'code'],
            message: `Duplicate value code "${value.code}" in family "${family.code}"`,
          })
        }
        valueCodes.add(value.code)
      })
    })
    model.constraints.forEach((constraint, ci) => {
      for (const [side, condition] of [
        ['when', constraint.when],
        ['require', constraint.require],
      ] as const) {
        const problem = findUndeclared(model, condition)
        if (problem) {
          ctx.addIssue({
            code: 'custom',
            path: ['constraints', ci, side],
            message: problem,
          })
        }
      }
    })
  })

export const makeSchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().max(200).default(''),
  selections: z.record(optionCodeSchema, optionCodeSchema),
  active: z.boolean().default(true),
})

export const makesSchema = z.array(makeSchema).superRefine((makes, ctx) => {
  const seen = new Set<string>()
  makes.forEach((make, i) => {
    const key = make.code.toLowerCase()
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'code'],
        message: `Duplicate make code "${make.code}"`,
      })
    }
    seen.add(key)
  })
})

/**
 * The first family or value a condition names that the model does not
 * declare, as a message; `null` when every reference resolves.
 */
export function findUndeclared(
  model: OptionModel,
  condition: OptionCondition,
): string | null {
  for (const entry of condition.all) {
    const family = model.families.find((f) => f.code === entry.family)
    if (!family) return `Option family "${entry.family}" is not declared`
    for (const value of entry.values) {
      if (!family.values.some((v) => v.code === value)) {
        return `Value "${value}" is not declared in family "${entry.family}"`
      }
    }
  }
  return null
}

export interface SelectionIssue {
  severity: 'error' | 'warning'
  family?: string
  message: string
}

/**
 * Check a set of selections against a model: every family named exists and
 * its value is in the domain (error), every required family is selected
 * (error), and every constraint holds (error, with the constraint's message).
 */
export function validateSelectionsAgainst(
  model: OptionModel,
  selections: Record<string, string>,
): Array<SelectionIssue> {
  const issues: Array<SelectionIssue> = []
  for (const [family, value] of Object.entries(selections)) {
    const declared = model.families.find((f) => f.code === family)
    if (!declared) {
      issues.push({
        severity: 'error',
        family,
        message: `Option family "${family}" is not declared`,
      })
      continue
    }
    if (!declared.values.some((v) => v.code === value)) {
      issues.push({
        severity: 'error',
        family,
        message: `"${value}" is not a value of "${family}"`,
      })
    }
  }
  for (const family of model.families) {
    if (family.required && selections[family.code] === undefined) {
      issues.push({
        severity: 'error',
        family: family.code,
        message: `Select a value for "${family.name}"`,
      })
    }
  }
  for (const constraint of model.constraints) {
    if (
      conditionMatches(constraint.when, selections) &&
      !conditionMatches(constraint.require, selections)
    ) {
      issues.push({
        severity: 'error',
        message:
          constraint.message ||
          `When ${formatOptionText(constraint.when)}, ${formatOptionText(constraint.require)} is required`,
      })
    }
  }
  return issues
}
