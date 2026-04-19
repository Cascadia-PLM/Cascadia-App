import { z } from 'zod'

export const parametricGenerationPayloadSchema = z.object({
  partTempId: z.string(),
  partName: z.string(),
  itemId: z.string().uuid(),
  branchId: z.string().uuid(),
  userId: z.string().uuid(),
  spec: z.object({
    shapeTemplate: z.string(),
    parameters: z.record(z.string(), z.number()),
    units: z.enum(['mm', 'in']),
  }),
})

export type ParametricGenerationPayload = z.infer<
  typeof parametricGenerationPayloadSchema
>

export const parametricGenerationResultSchema = z.object({
  partTempId: z.string(),
  vaultFileId: z.string().uuid(),
  fileName: z.string(),
  generationTimeMs: z.number(),
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

export type ParametricGenerationResult = z.infer<
  typeof parametricGenerationResultSchema
>
