// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

// Re-export main interfaces and types
export * from './types'
export { JobTypeRegistry } from './registry'
export { JobService } from './JobService'
export type { Job, JobLog, SubmitJobOptions, JobFilter } from './JobService'

// Re-export RabbitMQ client (for direct use if needed)
export { RabbitMQClient } from './rabbitmq/client'
export { RABBITMQ_CONFIG } from './rabbitmq/types'
