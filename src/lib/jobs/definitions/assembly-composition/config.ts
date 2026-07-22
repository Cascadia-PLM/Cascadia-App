import {
  assemblyComposePayloadSchema,
  assemblyComposeResultSchema,
} from './types'
import type { AssemblyComposePayload, AssemblyComposeResult } from './types'
import type { JobTypeConfig } from '../../types'

export const assemblyComposeConfig: JobTypeConfig<
  AssemblyComposePayload,
  AssemblyComposeResult
> = {
  type: 'generation.cad.assemble',
  label: 'Assembly STEP Composition',
  routingKey: 'jobs.generation.cad.assemble',
  payloadSchema: assemblyComposePayloadSchema,
  resultSchema: assemblyComposeResultSchema,
  timeout: 180000, // 3 minutes — STEP import of many children can be slow
  maxAttempts: 3,
  retryDelays: [5000, 15000, 30000],
  priority: 'high',
}
