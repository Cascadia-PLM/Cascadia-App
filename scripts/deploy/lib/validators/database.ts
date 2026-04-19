/**
 * Database connection validation
 */

import postgres from 'postgres'
import chalk from 'chalk'
import ora from 'ora'

export interface DatabaseValidationResult {
  success: boolean
  error?: string
  hint?: string
}

/**
 * Test a PostgreSQL database connection
 */
export async function validateDatabaseConnection(
  connectionString: string,
): Promise<DatabaseValidationResult> {
  const spinner = ora('Testing database connection...').start()

  let sql: ReturnType<typeof postgres> | null = null

  try {
    sql = postgres(connectionString, {
      connect_timeout: 10,
      max: 1,
    })

    // Test basic connectivity
    await sql`SELECT 1 as test`

    spinner.succeed(chalk.green('Database connection successful'))
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    spinner.fail(chalk.red(`Database connection failed: ${errorMessage}`))

    // Provide helpful hints based on error
    let hint: string | undefined
    if (errorMessage.includes('ECONNREFUSED')) {
      hint = 'Is PostgreSQL running? Check the host and port.'
    } else if (errorMessage.includes('password authentication failed')) {
      hint = 'Check your username and password.'
    } else if (errorMessage.includes('does not exist')) {
      hint = 'The database may not exist. Create it first.'
    } else if (errorMessage.includes('ETIMEDOUT')) {
      hint =
        'Connection timed out. Check firewall rules and network connectivity.'
    } else if (errorMessage.includes('SSL')) {
      hint =
        'SSL connection issue. Try adding ?sslmode=require or ?sslmode=disable to the connection string.'
    }

    if (hint) {
      console.log(chalk.yellow(`  Hint: ${hint}`))
    }

    return { success: false, error: errorMessage, hint }
  } finally {
    if (sql) {
      await sql.end()
    }
  }
}

/**
 * Build a PostgreSQL connection string from components
 */
export function buildConnectionString(config: {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl?: boolean
}): string {
  const sslParam = config.ssl ? '?sslmode=require' : ''
  const encodedPassword = encodeURIComponent(config.password)
  return `postgresql://${config.user}:${encodedPassword}@${config.host}:${config.port}/${config.database}${sslParam}`
}

/**
 * Parse a PostgreSQL connection string into components
 */
export function parseConnectionString(connectionString: string): {
  host: string
  port: number
  database: string
  user: string
  password: string
} | null {
  try {
    const url = new URL(connectionString)
    return {
      host: url.hostname,
      port: parseInt(url.port || '5432', 10),
      database: url.pathname.slice(1),
      user: url.username,
      password: decodeURIComponent(url.password),
    }
  } catch {
    return null
  }
}
