// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

/**
 * Payload for expired session cleanup job
 */
export const sessionCleanupPayloadSchema = z.object({})

export type SessionCleanupPayload = z.infer<typeof sessionCleanupPayloadSchema>

/**
 * Result of expired session cleanup job
 */
export const sessionCleanupResultSchema = z.object({
  /** Number of expired sessions removed */
  expiredSessionsRemoved: z.number().int().min(0),
  /** Number of expired file checkout locks released */
  expiredCheckoutsReleased: z.number().int().min(0),
})

export type SessionCleanupResult = z.infer<typeof sessionCleanupResultSchema>
