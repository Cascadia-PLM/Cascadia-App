// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import type { Serialized } from './serialized'

/** A JSON value, spelled so it stays compatible with Drizzle's JSONB inference. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | { [key: string]: JsonValue }

/**
 * Which writes a protected main refuses, set per program.
 *
 * Main becomes protected once anything in a design is released; the scope
 * decides what that protects:
 *
 * - `design` (the default, and the rule before the setting existed): every
 *   Driven item in the design changes only through a change-order or
 *   workspace branch.
 * - `released-items`: an item on main is protected when its own state is in
 *   its lifecycle's released family, or when it sits — at any depth — in the
 *   BOM, on main, beneath an item that is. Everything else stays editable on
 *   main.
 *
 * The verdict for one item is `canEditOnMain` in
 * `cascadia-api/src/items/branch-protection.ts`; nothing else decides it.
 */
export const BRANCH_PROTECTION_SCOPES = ['design', 'released-items'] as const

export const branchProtectionScopeSchema = z.enum(BRANCH_PROTECTION_SCOPES)

export type BranchProtectionScope = z.infer<typeof branchProtectionScopeSchema>

/** What a program that never chose a scope gets. */
export const DEFAULT_BRANCH_PROTECTION_SCOPE: BranchProtectionScope = 'design'

/**
 * Every key a program's `settings` may carry, and the only ones a request may
 * write.
 *
 * Strict, like every other request body since unknown keys became a 400: the
 * column is JSONB, so a misspelled key would otherwise be stored, echoed back,
 * and change nothing. `approvalWorkflow` and `changeOrderNumberFormat` are
 * declared because they are this column's documented keys and stored rows
 * carry them (migration 0004 renamed the second from `ecoNumberFormat`); no
 * code reads either today. A request writes keys, never removes them: the
 * service merges what it is given into what is stored.
 */
export const programSettingsSchema = z.strictObject({
  /** Approval stages, e.g. `['Engineering', 'Manufacturing', 'Quality']`. */
  approvalWorkflow: z.array(z.string().min(1).max(100)).max(50).optional(),
  /** e.g. `'ECO-{YYYY}-{NNN}'`. */
  changeOrderNumberFormat: z.string().min(1).max(100).optional(),
  branchProtectionScope: branchProtectionScopeSchema.optional(),
})

export type ProgramSettings = z.infer<typeof programSettingsSchema>

/** The scope a stored settings blob selects; anything unrecognised is the default. */
export function branchProtectionScopeOf(
  settings: { branchProtectionScope?: unknown } | null | undefined,
): BranchProtectionScope {
  const parsed = branchProtectionScopeSchema.safeParse(
    settings?.branchProtectionScope,
  )
  return parsed.success ? parsed.data : DEFAULT_BRANCH_PROTECTION_SCOPE
}

/**
 * A `programs` row. Hand-written here so the web can name it without the
 * schema; `db/schema/programs.ts` asserts it matches the table.
 */
export interface ProgramRow {
  id: string
  name: string
  code: string
  description: string | null
  contractNumber: string | null
  customer: string | null
  startDate: Date | null
  targetEndDate: Date | null
  status: string
  settings: ProgramSettings | null
  attributes: Record<string, unknown> | null
  createdAt: Date
  createdBy: string
  updatedAt: Date
  updatedBy: string | null
}

/**
 * A program as the client receives it: the DB row serialized over HTTP, so
 * timestamp columns arrive as ISO strings, not Date objects.
 */
export type Program = Serialized<ProgramRow> & {
  userRole?: string
}
export type ProgramMemberRole = 'admin' | 'lead' | 'engineer' | 'viewer'

/**
 * A program-membership row as `/api/v1/programs/:id/members` returns it,
 * with the user identity joined in for display.
 */
export interface ProgramMember {
  id: string
  programId: string
  userId: string
  role: ProgramMemberRole
  canCreateEco: boolean | null
  canApproveEco: boolean | null
  canManageDesigns: boolean | null
  joinedAt: string
  invitedBy: string | null
  user: { id: string; name: string | null; email: string }
}

/**
 * The body `POST`/`PUT /api/v1/programs` accepts, spelled from the client's
 * side. It is hand-written rather than inferred from `programCreateSchema`
 * because that schema's inferred type describes its *output* — `Date` objects,
 * which no JSON request can carry — while a caller sends strings.
 *
 * The date fields therefore admit `null` as well as a string: that is how a
 * cleared date is spelled on the wire, and what the server's `clearableDate`
 * normalizes. Keep the two in step — nothing checks that they agree.
 */
export type CreateProgramInput = {
  name: string
  code: string
  description?: string
  contractNumber?: string
  customer?: string
  startDate?: Date | string | null
  targetEndDate?: Date | string | null
  status?: 'Active' | 'On Hold' | 'Completed' | 'Cancelled'
  attributes?: Record<string, unknown>
  settings?: ProgramSettings
}

export type UpdateProgramInput = Partial<CreateProgramInput>
