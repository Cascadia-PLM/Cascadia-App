// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

export const wiPartChangedPayloadSchema = z
  .object({
    /**
     * The change order whose release changed the parts. `ecoId` is the key
     * this shipped under; a row queued before the rename still carries it, so
     * both are accepted for one release and the handler reads either.
     */
    changeOrderId: z.string().uuid().optional(),
    ecoId: z.string().uuid().optional(),
    changedPartIds: z.array(z.string().uuid()),
    userId: z.string().uuid(),
    changeDetails: z
      .record(
        z.string(),
        z.object({
          changedFields: z.array(z.string()).optional(),
          previousValues: z.record(z.string(), z.unknown()).optional(),
          newValues: z.record(z.string(), z.unknown()).optional(),
          changeType: z
            .enum(['part_modified', 'part_obsoleted', 'parametric_stale'])
            .default('part_modified'),
        }),
      )
      .optional(),
  })
  .refine((p) => p.changeOrderId !== undefined || p.ecoId !== undefined, {
    message: 'changeOrderId is required',
  })

export type WiPartChangedPayload = z.infer<typeof wiPartChangedPayloadSchema>

export const wiPartChangedResultSchema = z.object({
  alertsCreated: z.number(),
  workInstructionsAffected: z.number(),
})

export type WiPartChangedResult = z.infer<typeof wiPartChangedResultSchema>
