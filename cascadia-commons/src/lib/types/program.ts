// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { Serialized } from './serialized'

/**
 * A JSON value, spelled so a settings blob's index signature stays compatible
 * with Drizzle's JSONB type inference.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | { [key: string]: JsonValue }

export interface ProgramSettings {
  approvalWorkflow?: Array<string> // ['Engineering', 'Manufacturing', 'Quality']
  // Renamed from `ecoNumberFormat`; migration 0004 moves the stored key
  changeOrderNumberFormat?: string // 'ECO-{YYYY}-{NNN}'
  [key: string]: JsonValue | undefined
}

/**
 * A `programs` row. Hand-written here so the web can name it without the
 * schema; `lib/db/schema/programs.ts` asserts it matches the table.
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
}

export type UpdateProgramInput = Partial<CreateProgramInput>
