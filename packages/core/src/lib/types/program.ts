// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { programs } from '@/lib/db/schema/programs'
import type { Serialized } from './serialized'

/**
 * A program as the client receives it: the DB row serialized over HTTP, so
 * timestamp columns arrive as ISO strings, not Date objects.
 */
export type Program = Serialized<typeof programs.$inferSelect> & {
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

export type CreateProgramInput = {
  name: string
  code: string
  description?: string
  contractNumber?: string
  customer?: string
  startDate?: Date | string
  targetEndDate?: Date | string
  status?: 'Active' | 'On Hold' | 'Completed' | 'Cancelled'
  attributes?: Record<string, unknown>
}

export type UpdateProgramInput = Partial<CreateProgramInput>
