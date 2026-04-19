import { z } from 'zod'

export const wiPartChangedPayloadSchema = z.object({
  ecoId: z.string().uuid(),
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

export type WiPartChangedPayload = z.infer<typeof wiPartChangedPayloadSchema>

export const wiPartChangedResultSchema = z.object({
  alertsCreated: z.number(),
  workInstructionsAffected: z.number(),
})

export type WiPartChangedResult = z.infer<typeof wiPartChangedResultSchema>
