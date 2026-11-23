// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

export type CadOutputFormat = 'glb' | 'stl'

/**
 * Default derivative formats to store.
 *
 * The historical behavior was both GLB and STL. Deployments that only need the
 * web viewer can set CAD_DEFAULT_OUTPUT_FORMATS=glb; CAM/printing deployments
 * keep the default.
 */
export function defaultCadOutputFormats(): Array<CadOutputFormat> {
  const raw = process.env.CAD_DEFAULT_OUTPUT_FORMATS?.trim()
  if (!raw) return ['glb', 'stl']
  const formats = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is CadOutputFormat =>
      value === 'glb' || value === 'stl',
    )
  return formats.length > 0 ? [...new Set(formats)] : ['glb', 'stl']
}

export const cadConversionPayloadSchema = z.object({
  vaultFileId: z.string().uuid(),
  itemId: z.string().uuid(),
  outputBranchId: z.string().uuid().nullable().optional(),
  outputFormat: z.string().default('stl'),
  outputFormats: z.array(z.enum(['glb', 'stl'])).default(defaultCadOutputFormats()),
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
