import { z } from 'zod'

const vector3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
})

export const assemblyComposePayloadSchema = z.object({
  assemblyTempId: z.string(),
  assemblyName: z.string(),
  itemId: z.string().uuid(),
  branchId: z.string().uuid(),
  userId: z.string().uuid(),
  placements: z
    .array(
      z.object({
        tempId: z.string(),
        partName: z.string(),
        stepFileKey: z.string().uuid(),
        transform: z.object({
          // Euler angles in degrees, applied rotateX → rotateY → rotateZ about
          // the global origin, then translated — matching kcl-generator.ts.
          translation: vector3Schema,
          rotation: vector3Schema,
        }),
        quantity: z.number().int().min(1),
      }),
    )
    .min(1),
})

export type AssemblyComposePayload = z.infer<
  typeof assemblyComposePayloadSchema
>

export const assemblyComposeResultSchema = z.object({
  assemblyTempId: z.string(),
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

export type AssemblyComposeResult = z.infer<typeof assemblyComposeResultSchema>
