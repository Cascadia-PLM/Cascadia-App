import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { getErrorStrategy } from './severity'
import type { AppError } from './AppError'
import { db } from '@/lib/db'
import { errorLogs } from '@/lib/db/schema'
import { apiLogger } from '@/lib/logging/logger'

interface LogErrorParams {
  error: AppError
  requestId?: string
  userId?: string
  method?: string
  path?: string
  userAgent?: string
}

/**
 * Service for logging errors to the database.
 * Provides methods for logging, querying, and analyzing errors.
 */
export class ErrorLogService {
  /**
   * Log an error to the database.
   * This is fire-and-forget - failures are silently ignored to avoid
   * breaking the application due to logging errors.
   */
  static async log(params: LogErrorParams): Promise<void> {
    const { error, requestId, userId, method, path, userAgent } = params

    try {
      const strategy = getErrorStrategy(error.code)

      await db.insert(errorLogs).values({
        code: error.code,
        message: error.message,
        severity: strategy.severity,
        httpStatus: error.httpStatus,
        isOperational: error.isOperational,
        requestId,
        userId,
        resource: error.context.resource,
        operation: error.context.operation,
        method,
        path,
        userAgent,
        stack: error.stack,
        context: error.context,
        fieldErrors: error.fieldErrors,
      })
    } catch (logError) {
      // Never let logging errors break the application
      apiLogger.error({ err: logError }, 'Failed to log error to database')
    }
  }

  /**
   * Get recent errors from the database.
   */
  static async getRecentErrors(
    options: {
      limit?: number
      code?: string
      severity?: string
      since?: Date
      userId?: string
    } = {},
  ) {
    const { limit = 100, code, severity, since, userId } = options

    const conditions = []
    if (code) conditions.push(eq(errorLogs.code, code))
    if (severity) conditions.push(eq(errorLogs.severity, severity))
    if (since) conditions.push(gte(errorLogs.createdAt, since))
    if (userId) conditions.push(eq(errorLogs.userId, userId))

    return db.query.errorLogs.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(errorLogs.createdAt)],
      limit,
      with: {
        user: {
          columns: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })
  }

  /**
   * Get error statistics grouped by error code.
   */
  static async getErrorStats(since: Date) {
    const result = await db
      .select({
        code: errorLogs.code,
        severity: errorLogs.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(errorLogs)
      .where(gte(errorLogs.createdAt, since))
      .groupBy(errorLogs.code, errorLogs.severity)
      .orderBy(sql`count(*) desc`)

    return result
  }

  /**
   * Get error count by severity level.
   */
  static async getErrorCountBySeverity(since: Date) {
    const result = await db
      .select({
        severity: errorLogs.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(errorLogs)
      .where(gte(errorLogs.createdAt, since))
      .groupBy(errorLogs.severity)

    return result
  }

  /**
   * Get error count over time (hourly buckets).
   */
  static async getErrorTimeline(since: Date, until: Date = new Date()) {
    const result = await db
      .select({
        hour: sql<string>`date_trunc('hour', ${errorLogs.createdAt})`,
        count: sql<number>`count(*)::int`,
      })
      .from(errorLogs)
      .where(
        and(gte(errorLogs.createdAt, since), lt(errorLogs.createdAt, until)),
      )
      .groupBy(sql`date_trunc('hour', ${errorLogs.createdAt})`)
      .orderBy(sql`date_trunc('hour', ${errorLogs.createdAt})`)

    return result
  }

  /**
   * Get a specific error by ID.
   */
  static async getById(id: string) {
    return db.query.errorLogs.findFirst({
      where: eq(errorLogs.id, id),
      with: {
        user: {
          columns: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    })
  }

  /**
   * Clean up old error logs.
   * @param olderThan - Delete errors created before this date
   * @returns The number of deleted records
   */
  static async cleanup(olderThan: Date): Promise<number> {
    const result = await db
      .delete(errorLogs)
      .where(lt(errorLogs.createdAt, olderThan))
      .returning({ id: errorLogs.id })

    return result.length
  }
}
