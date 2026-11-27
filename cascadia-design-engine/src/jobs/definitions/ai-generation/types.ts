// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `generation.cad.ai` — generate CAD for one existing part with the FreeCAD
 * agent, from the part detail page's "Generate CAD" dialog.
 *
 * The design engine drives the same agent inline from its CAD generation
 * stage; this job is the standalone entry point for a part that was not born
 * in a design session. It runs on the Node jobs worker, which in turn submits
 * `generation.cad.freecad` jobs to the FreeCAD worker for each attempt.
 */

import { z } from 'zod'

export const aiGenerationPayloadSchema = z.object({
  itemId: z.string().uuid(),
  partName: z.string(),
  partDescription: z.string(),
  material: z.string().optional(),
  userId: z.string().uuid(),
  /** Resolves the AI provider and budget; omitted for a part outside any program. */
  programId: z.string().uuid().optional(),
  /** The branch the stored STEP belongs to. */
  branchId: z.string().uuid().optional(),
})

export type AiGenerationPayload = z.infer<typeof aiGenerationPayloadSchema>

export const aiGenerationResultSchema = z.object({
  vaultFileId: z.string().uuid(),
  fileName: z.string(),
  /** Script attempts the agent needed. */
  iterations: z.number().int(),
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

export type AiGenerationResult = z.infer<typeof aiGenerationResultSchema>
