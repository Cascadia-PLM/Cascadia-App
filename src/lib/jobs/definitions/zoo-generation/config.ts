import { zooGenerationPayloadSchema, zooGenerationResultSchema } from './types'
import type { ZooGenerationPayload, ZooGenerationResult } from './types'
import type { JobTypeConfig } from '../../types'

export const zooGenerationConfig: JobTypeConfig<
  ZooGenerationPayload,
  ZooGenerationResult
> = {
  type: 'generation.cad.zoo',
  label: 'Zoo Text-to-CAD Generation',
  routingKey: 'jobs.generation.cad.zoo',
  payloadSchema: zooGenerationPayloadSchema,
  resultSchema: zooGenerationResultSchema,
  timeout: 600000, // 10 minutes
  maxAttempts: 2,
  retryDelays: [60000, 120000],
  priority: 'normal',
}
