// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  parametricGenerationPayloadSchema,
  parametricGenerationResultSchema,
} from './types'
import type {
  ParametricGenerationPayload,
  ParametricGenerationResult,
} from './types'
import type { JobTypeConfig } from '@/jobs/types'

export const parametricGenerationConfig: JobTypeConfig<
  ParametricGenerationPayload,
  ParametricGenerationResult
> = {
  type: 'generation.cad.parametric',
  label: 'Parametric CAD Generation',
  routingKey: 'jobs.generation.cad.parametric',
  payloadSchema: parametricGenerationPayloadSchema,
  resultSchema: parametricGenerationResultSchema,
  timeout: 60000, // 1 minute (generous for ~1-2s generation)
  maxAttempts: 3,
  retryDelays: [5000, 15000, 30000],
  priority: 'high',
}
