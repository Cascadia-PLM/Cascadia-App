// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

// Stdio-based processes (the MCP dev server) reserve stdout for their
// protocol stream; LOG_DESTINATION=stderr reroutes all logging there.
const fd = process.env.LOG_DESTINATION === 'stderr' ? 2 : 1

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        destination: fd,
      },
    }
  : undefined

export const logger = transport
  ? pino({ level, transport })
  : pino({ level }, pino.destination(fd))

// Named child loggers for major subsystems
export const workerLogger = logger.child({ module: 'worker' })
export const jobLogger = logger.child({ module: 'jobs' })
export const rabbitmqLogger = logger.child({ module: 'rabbitmq' })
export const aiLogger = logger.child({ module: 'ai' })
export const authLogger = logger.child({ module: 'auth' })
export const apiLogger = logger.child({ module: 'api' })
export const itemLogger = logger.child({ module: 'items' })
export const vaultLogger = logger.child({ module: 'vault' })
export const serviceLogger = logger.child({ module: 'services' })
export const auditLogger = logger.child({ module: 'audit' })
export const cryptoLogger = logger.child({ module: 'crypto' })
