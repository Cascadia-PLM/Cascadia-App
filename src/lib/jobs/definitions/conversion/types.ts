import { z } from 'zod'

export const cadConversionPayloadSchema = z.object({
  vaultFileId: z.string().uuid(),
  itemId: z.string().uuid(),
  outputFormat: z.string().default('stl'),
  meshQuality: z.enum(['preview', 'standard', 'high']).default('standard'),
  decompose: z.boolean().default(false),
  userId: z.string().uuid(),
})

export type CadConversionPayload = z.infer<typeof cadConversionPayloadSchema>

export const cadConversionResultSchema = z.object({
  outputFileIds: z.array(z.string().uuid()),
  totalParts: z.number().int().min(0),
  polygonCount: z.number().int().min(0),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
    })
    .optional(),
  conversionTimeMs: z.number().int().min(0),
  thumbnailFileId: z.string().uuid().optional(),
  glbFileIds: z.array(z.string().uuid()).optional(),
  manifest: z
    .array(
      z.object({
        name: z.string(),
        stlFileId: z.string().uuid(),
        polygonCount: z.number().int(),
        boundingBox: z
          .object({
            x: z.number(),
            y: z.number(),
            z: z.number(),
          })
          .optional(),
        transform: z.array(z.number()).optional(),
        glbFileId: z.string().uuid().optional(),
        color: z.array(z.number()).length(3).optional(),
      }),
    )
    .optional(),
})

export type CadConversionResult = z.infer<typeof cadConversionResultSchema>
