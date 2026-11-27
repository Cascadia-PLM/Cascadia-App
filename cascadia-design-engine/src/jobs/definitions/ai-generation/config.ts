// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { aiGenerationPayloadSchema, aiGenerationResultSchema } from './types'
import type { AiGenerationPayload, AiGenerationResult } from './types'
import type { JobTypeConfig } from '@/jobs/types'

/**
 * The agent may make up to `maxIterations` (admin-configured, at most 12)
 * script attempts, each a model turn plus a FreeCAD run of up to 300 s, and
 * then one persisting run. The timeout is sized for that worst case rather
 * than the typical one-to-three-attempt part, because the Node worker's
 * abort is what ends a run that goes long — and a retry would start the
 * whole conversation over.
 */
export const aiGenerationConfig: JobTypeConfig<
  AiGenerationPayload,
  AiGenerationResult
> = {
  type: 'generation.cad.ai',
  label: 'AI CAD Generation (FreeCAD)',
  routingKey: 'jobs.generation.cad.ai',
  payloadSchema: aiGenerationPayloadSchema,
  resultSchema: aiGenerationResultSchema,
  timeout: 1800000, // 30 minutes
  maxAttempts: 2,
  retryDelays: [30000],
  priority: 'normal',
}
