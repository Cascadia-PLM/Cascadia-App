import {
  mechanismGenerationPayloadSchema,
  mechanismGenerationResultSchema,
} from './types'
import type {
  MechanismGenerationPayload,
  MechanismGenerationResult,
} from './types'
import type { JobTypeConfig } from '../../types'

export const mechanismGenerationConfig: JobTypeConfig<
  MechanismGenerationPayload,
  MechanismGenerationResult
> = {
  type: 'generation.cad.mechanism',
  label: 'Mechanism CAD Generation',
  routingKey: 'jobs.generation.cad.mechanism',
  payloadSchema: mechanismGenerationPayloadSchema,
  resultSchema: mechanismGenerationResultSchema,
  timeout: 120000, // 2 minutes (multi-part generation is more complex)
  maxAttempts: 3,
  retryDelays: [5000, 15000, 30000],
  priority: 'high',
}
