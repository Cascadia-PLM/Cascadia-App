import { wiPartChangedPayloadSchema, wiPartChangedResultSchema } from './types'
import type { JobTypeConfig } from '../../types'
import type { WiPartChangedPayload, WiPartChangedResult } from './types'

export const wiPartChangedConfig: JobTypeConfig<
  WiPartChangedPayload,
  WiPartChangedResult
> = {
  type: 'notification.workinstruction.partchanged',
  label: 'Work Instruction Part Change Notification',
  routingKey: 'jobs.notification.workinstruction',
  payloadSchema: wiPartChangedPayloadSchema,
  resultSchema: wiPartChangedResultSchema,
  timeout: 120000, // 2 minutes
  maxAttempts: 3,
  retryDelays: [30000, 60000, 120000],
  priority: 'normal',
}
