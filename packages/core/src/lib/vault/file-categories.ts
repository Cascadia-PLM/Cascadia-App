// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The vocabulary of vault file categories, shared by the server (auto-detection
 * and validation) and the client (badges, filters, and the category picker).
 *
 * Deliberately free of Node and database imports so client bundles can import
 * it — `file-utils.ts` pulls in `node:crypto` and `node:path` and is not a safe
 * home for anything the UI needs.
 *
 * To add a category: add it to `FILE_CATEGORY_VALUES` and give it an entry in
 * `FILE_CATEGORY_DEFINITIONS`. The picker, the badges, and the column filters
 * all follow automatically.
 */

export const FILE_CATEGORY_VALUES = [
  'cad_model',
  'drawing',
  'specification',
  'analysis',
  'reference',
  'other',
] as const

export type FileCategory = (typeof FILE_CATEGORY_VALUES)[number]

/**
 * Category applied by the CAD converter to the preview images it generates.
 * System-managed: excluded from file listings, and never user-assignable.
 */
export const THUMBNAIL_FILE_CATEGORY = 'thumbnail'

export type BadgeVariant =
  'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'

export interface FileCategoryDefinition {
  /** Full name — menus, filters, and the picker */
  label: string
  /** Short name for the row badge, where horizontal space is tight */
  badgeLabel: string
  badgeVariant: BadgeVariant
  /**
   * Whether to badge the row. 'reference' and 'other' say nothing a reader
   * cannot see from the filename, so they stay unbadged.
   */
  badged: boolean
}

export const FILE_CATEGORY_DEFINITIONS: Record<
  FileCategory,
  FileCategoryDefinition
> = {
  cad_model: {
    label: 'CAD Model',
    badgeLabel: 'CAD Model',
    badgeVariant: 'default',
    badged: true,
  },
  drawing: {
    label: 'Drawing',
    badgeLabel: 'Drawing',
    badgeVariant: 'secondary',
    badged: true,
  },
  specification: {
    label: 'Specification',
    badgeLabel: 'Spec',
    badgeVariant: 'outline',
    badged: true,
  },
  analysis: {
    label: 'Analysis',
    badgeLabel: 'Analysis',
    badgeVariant: 'warning',
    badged: true,
  },
  reference: {
    label: 'Reference',
    badgeLabel: 'Reference',
    badgeVariant: 'outline',
    badged: false,
  },
  other: {
    label: 'Other',
    badgeLabel: 'Other',
    badgeVariant: 'outline',
    badged: false,
  },
}

/** Whether a category was auto-detected at upload or set by a person. */
export const CATEGORY_SOURCES = ['auto', 'manual'] as const
export type CategorySource = (typeof CATEGORY_SOURCES)[number]

export function isFileCategory(value: unknown): value is FileCategory {
  return (
    typeof value === 'string' &&
    (FILE_CATEGORY_VALUES as ReadonlyArray<string>).includes(value)
  )
}

/** Display name for a stored category, tolerating legacy and system values. */
export function fileCategoryLabel(category: string | null | undefined): string {
  if (!category) return 'Uncategorized'
  if (category === THUMBNAIL_FILE_CATEGORY) return 'Thumbnail'
  return isFileCategory(category)
    ? FILE_CATEGORY_DEFINITIONS[category].label
    : category
}

/** Options for a select or filter control, in display order. */
export const FILE_CATEGORY_OPTIONS: Array<{
  value: FileCategory
  label: string
}> = FILE_CATEGORY_VALUES.map((value) => ({
  value,
  label: FILE_CATEGORY_DEFINITIONS[value].label,
}))
