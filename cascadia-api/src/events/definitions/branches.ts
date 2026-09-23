// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

export const branchPayloadSchema = z.object({
  branchId: z.string().uuid(),
  designId: z.string().uuid(),
  name: z.string(),
  branchType: z.string(),
  /** The change order an ECO branch belongs to; null for other types. */
  changeOrderItemId: z.string().uuid().nullable(),
  baseCommitId: z.string().uuid().nullable(),
})

export type BranchPayload = z.infer<typeof branchPayloadSchema>

/** A branch (ECO, workspace or release) was created on a design. */
export const BRANCH_CREATED = defineDomainEvent({
  type: 'branch.created',
  schemaVersion: 1,
  description: 'A branch was created',
  subjectType: 'branch',
  payloadSchema: branchPayloadSchema,
})

/**
 * A branch was archived — after its ECO released or was cancelled. Emitted
 * in the caller's transaction when there is one (the merge), so the archive
 * and the release it belongs to commit together.
 */
export const BRANCH_ARCHIVED = defineDomainEvent({
  type: 'branch.archived',
  schemaVersion: 1,
  description: 'A branch was archived',
  subjectType: 'branch',
  payloadSchema: branchPayloadSchema,
})
