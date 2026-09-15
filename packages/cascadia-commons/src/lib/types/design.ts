// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/** How a Manufacturing design was resolved from its source (product variants). */
export interface DesignConfiguration {
  /** The configurable part the selections were resolved against. */
  rootItemId: string
  /** The make the selections came from, when one was named. */
  makeCode: string | null
  /** Option family code → value code. */
  selections: Record<string, string>
}

/**
 * A `designs` row. Hand-written here so the web can name it without the
 * schema; `lib/db/schema/designs.ts` asserts it matches the table.
 */
export interface DesignRow {
  id: string
  programId: string | null
  name: string
  code: string
  description: string | null
  designType: string
  parentDesignId: string | null
  cloneSourceDesignId: string | null
  sourceDesignId: string | null
  sourceTagId: string | null
  sourceCommitId: string | null
  configuration: DesignConfiguration | null
  plannedQuantity: number | null
  defaultBranchId: string | null
  isArchived: boolean | null
  sysmlProjectId: string | null
  attributes: Record<string, unknown> | null
  createdAt: Date
  createdBy: string
  updatedAt: Date
  updatedBy: string | null
}

export type Design = DesignRow

export type CreateDesignInput = {
  programId?: string | null
  name: string
  code: string
  description?: string
  designType?: 'Engineering' | 'Library' | 'Family'
  parentDesignId?: string | null
  plannedQuantity?: number
  attributes?: Record<string, unknown>
}

export type UpdateDesignInput = Partial<Omit<CreateDesignInput, 'designType'>>
