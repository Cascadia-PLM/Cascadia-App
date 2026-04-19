import pino from 'pino'

const isDev = process.env.NODE_ENV !== 'production'
const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    }
  : undefined

export const logger = pino({
  level,
  ...(transport ? { transport } : {}),
})

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
