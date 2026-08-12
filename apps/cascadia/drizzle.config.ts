// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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

// drizzle-kit loads .env itself, so this is normally set. No fallback: a
// default here would push schema at the wrong database when .env is absent
// (a fresh worktree, say) instead of failing.
const rawUrl = process.env.DATABASE_URL
if (!rawUrl) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and point ' +
      'DATABASE_URL at your database, or export it in the environment.',
  )
}
const parsed = parseConnectionUrl(rawUrl)

export default defineConfig({
  dialect: 'postgresql',
  // This edition's composed schema — core plus every module's tables.
  schema: './src/modules.schema.ts',
  out: '../../drizzle',
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
