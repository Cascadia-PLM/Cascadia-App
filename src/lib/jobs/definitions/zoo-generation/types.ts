import { z } from 'zod'

export const zooGenerationPayloadSchema = z.object({
  itemId: z.string().uuid(),
  partName: z.string(),
  partDescription: z.string(),
  userId: z.string().uuid(),
})

export type ZooGenerationPayload = z.infer<typeof zooGenerationPayloadSchema>

export const zooGenerationResultSchema = z.object({
  vaultFileId: z.string().uuid(),
  fileName: z.string(),
  zooRequestId: z.string(),
  generationTimeMs: z.number(),
})

export type ZooGenerationResult = z.infer<typeof zooGenerationResultSchema>
