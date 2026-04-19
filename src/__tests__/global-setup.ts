/**
 * Global Setup for Vitest
 *
 * This file runs once before all test files.
 * Use for one-time setup like database connections or environment validation.
 */

export default function globalSetup() {
  // Validate required environment variables for testing
  const requiredEnvVars = ['DATABASE_URL']
  const missingVars = requiredEnvVars.filter((v) => !process.env[v])

  if (missingVars.length > 0 && process.env.CI) {
    throw new Error(
      `Missing required environment variables for testing: ${missingVars.join(', ')}`,
    )
  }

  // Set test-specific environment variables
  process.env.NODE_ENV = 'test'

  // Log test configuration
  console.log('\n🧪 Test Environment Configuration:')
  console.log(
    `   Database: ${process.env.DATABASE_URL ? 'Configured' : 'Using default'}`,
  )
  console.log(`   Node ENV: ${process.env.NODE_ENV}`)
  console.log('')
}

export function teardown() {
  // Global cleanup if needed
  console.log('\n🧹 Test suite completed, cleaning up...\n')
}
