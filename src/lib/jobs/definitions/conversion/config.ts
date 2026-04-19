import { cadConversionPayloadSchema, cadConversionResultSchema } from './types'
import type { CadConversionPayload, CadConversionResult } from './types'
import type { JobTypeConfig } from '../../types'

export const cadConversionConfig: JobTypeConfig<
  CadConversionPayload,
  CadConversionResult
> = {
  type: 'conversion.cad.step-to-stl',
  label: 'CAD to STL Conversion',
  routingKey: 'jobs.conversion.cad',
  payloadSchema: cadConversionPayloadSchema,
  resultSchema: cadConversionResultSchema,
  timeout: 600000, // 10 minutes for large assemblies
  maxAttempts: 2,
  retryDelays: [60000, 120000],
  priority: 'normal',
}
