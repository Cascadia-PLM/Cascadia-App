// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Client-safe helpers for *displaying* numbering schemes.
 *
 * This module intentionally imports only the pure scheme data (`./schemes`)
 * and types — never `NumberingService` (which pulls in the database). That
 * keeps it importable from React components and the admin UI without dragging
 * server-only code into the client bundle. Do NOT import from `./index` here.
 *
 * Everything here is side-effect free: it renders *example* numbers without
 * touching the sequence counters, so it is safe to call anywhere.
 */
import { familyNumberingConfig, numberingSchemes } from './schemes'
import type { NumberSegment, SequenceScope } from './types'

/** Placeholder shown in every item-number input when the field is left blank. */
export const ITEM_NUMBER_PLACEHOLDER = 'Auto-generated if blank'

/**
 * Render a single segment as a representative example, WITHOUT consuming a
 * sequence value. Sequence segments render as their zero-padded starting value;
 * dynamic segments (design code, fields, dates) render as short placeholder
 * tokens so the shape of the number is still clear.
 */
function renderSegmentExample(segment: NumberSegment): string {
  switch (segment.type) {
    case 'literal':
      return segment.value
    case 'sequence':
      return String(segment.startAt ?? 1).padStart(segment.padding ?? 6, '0')
    case 'design-code':
      return '{design}'
    case 'field':
      return `{${segment.field}}`
    case 'lookup':
      return segment.default ?? Object.values(segment.map)[0] ?? '{code}'
    case 'date':
      return segment.format
    case 'family-sequence':
      return String(1).padStart(segment.padding ?? 3, '0')
  }
}

/**
 * A representative example of the number an item type will be assigned,
 * e.g. `PN-000001`. Returns `null` if the type has no numbering scheme.
 */
export function formatSchemeExample(itemType: string): string | null {
  const scheme = numberingSchemes[itemType]
  if (!scheme) return null
  const separator = scheme.separator ?? '-'
  return scheme.segments.map(renderSegmentExample).join(separator)
}

/** Whether an item type permits manually-entered numbers. */
export function allowsManualEntry(itemType: string): boolean {
  return numberingSchemes[itemType]?.allowManualEntry ?? false
}

/**
 * The standardized help text for an item-number field. Used by
 * `ItemNumberField` so every item form says the same thing.
 */
export function getItemNumberHelpText(itemType: string): string {
  const example = formatSchemeExample(itemType)
  const suffix = example ? ` (e.g., ${example})` : ''
  return allowsManualEntry(itemType)
    ? `Leave blank to auto-generate${suffix}`
    : `Auto-generated on creation${suffix}`
}

/** Human-readable description of when a sequence counter resets. */
function describeSequenceScope(scope: SequenceScope | undefined): string {
  switch (scope) {
    case 'design':
      return 'restarts per design'
    case 'prefix':
      return 'restarts per prefix'
    case 'yearly':
      return 'restarts each year'
    default:
      return 'never restarts (global)'
  }
}

/** Human-readable description of a single segment, for the admin display. */
function describeSegment(segment: NumberSegment): string {
  switch (segment.type) {
    case 'literal':
      return `Fixed text "${segment.value}"`
    case 'sequence': {
      const digits = segment.padding ?? 6
      const start = segment.startAt ?? 1
      return `Sequence — ${digits}-digit number starting at ${start}, ${describeSequenceScope(segment.scope)}`
    }
    case 'design-code':
      return 'Design code'
    case 'field':
      return `Value of the "${segment.field}" field${segment.transform ? ` (${segment.transform})` : ''}`
    case 'lookup':
      return `Code looked up from the "${segment.field}" field`
    case 'date':
      return `Date (${segment.format})`
    case 'family-sequence':
      return `Family variant — ${segment.padding ?? 3}-digit number`
  }
}

export interface NumberingInfo {
  itemType: string
  /** e.g. `PN-000001`, or `null` if no scheme is defined. */
  example: string | null
  separator: string
  allowManualEntry: boolean
  familyVariants: { enabled: boolean; example: string | null }
  segments: Array<{ type: NumberSegment['type']; description: string }>
}

/**
 * Full read-only description of an item type's numbering scheme, for the admin
 * item-type page. Returns `null` if the type has no scheme defined in code.
 */
export function getNumberingInfo(itemType: string): NumberingInfo | null {
  const scheme = numberingSchemes[itemType]
  if (!scheme) return null

  const separator = scheme.separator ?? '-'
  const example = formatSchemeExample(itemType)

  const family = familyNumberingConfig[itemType]
  const familyEnabled = family?.enabled ?? false
  const familyExample =
    familyEnabled && example
      ? `${example}${family?.separator ?? '-'}${String(1).padStart(family?.padding ?? 3, '0')}`
      : null

  return {
    itemType,
    example,
    separator,
    allowManualEntry: scheme.allowManualEntry ?? false,
    familyVariants: { enabled: familyEnabled, example: familyExample },
    segments: scheme.segments.map((s) => ({
      type: s.type,
      description: describeSegment(s),
    })),
  }
}
