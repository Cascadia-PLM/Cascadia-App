import { defineConfig } from 'drizzle-kit'

// Parse DATABASE_URL for Cloud SQL Unix socket support
// Cloud SQL URLs use ?host=/cloudsql/instance format which drizzle-kit doesn't parse correctly
function parseConnectionUrl(connStr: string) {
  try {
    const url = new URL(connStr)
    const socketPath = url.searchParams.get('host')

    if (socketPath && socketPath.startsWith('/cloudsql/')) {
      // Cloud SQL Unix socket - use individual credentials
      return {
        isCloudSql: true,
        host: socketPath,
        user: url.username,
        password: url.password,
        database: url.pathname.slice(1), // Remove leading /
      }
    }
  } catch {
    // Not a valid URL, return as-is
  }
  return { isCloudSql: false, url: connStr }
}

const rawUrl =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/cascadia'
const parsed = parseConnectionUrl(rawUrl)

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: parsed.isCloudSql
    ? {
        host: parsed.host!,
        user: parsed.user!,
        password: parsed.password!,
        database: parsed.database!,
      }
    : {
        url: parsed.url!,
      },
})
