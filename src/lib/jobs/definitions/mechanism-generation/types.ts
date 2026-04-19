import { z } from 'zod'

export const mechanismGenerationPayloadSchema = z.object({
  assemblyTempId: z.string(),
  assemblyName: z.string(),
  mechanismType: z.string(),
  parameters: z.record(z.string(), z.number()),
  units: z.enum(['mm', 'in']),
  partMapping: z.array(
    z.object({
      role: z.string(),
      tempId: z.string(),
      itemId: z.string().uuid(),
    }),
  ),
  branchId: z.string().uuid(),
  userId: z.string().uuid(),
})

export type MechanismGenerationPayload = z.infer<
  typeof mechanismGenerationPayloadSchema
>

const mechanismPartOutputSchema = z.object({
  vaultFileId: z.string().uuid(),
  fileName: z.string(),
  boundingBox: z
    .object({
      minX: z.number(),
      minY: z.number(),
      minZ: z.number(),
      maxX: z.number(),
      maxY: z.number(),
      maxZ: z.number(),
    })
    .optional(),
})

export const mechanismGenerationResultSchema = z.object({
  assemblyTempId: z.string(),
  mechanismType: z.string(),
  generationTimeMs: z.number(),
  outputs: z.record(z.string(), mechanismPartOutputSchema),
  metadata: z.record(z.string(), z.unknown()),
})

export type MechanismGenerationResult = z.infer<
  typeof mechanismGenerationResultSchema
>
