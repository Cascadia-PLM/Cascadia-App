// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Sync Role Permissions
 * Updates all roles in the database to match the current ROLE_DEFINITIONS in code.
 * Run this after adding new permissions to permissions.ts.
 */
import { db } from '@cascadia/api/lib/db'
import { roles } from '@cascadia/api/lib/db/schema/users'
import {
  ROLE_DEFINITIONS,
  roleToDbFormat,
} from '@cascadia/commons/lib/auth/permissions'

async function syncRolePermissions() {
  console.log('Syncing role permissions from code to database...\n')

  for (const [, roleDef] of Object.entries(ROLE_DEFINITIONS)) {
    const dbPermissions = roleToDbFormat(roleDef)

    const result = await db
      .update(roles)
      .set({ permissions: dbPermissions })
      .where((await import('drizzle-orm')).eq(roles.name, roleDef.name))
      .returning({ id: roles.id, name: roles.name })

    if (result.length > 0) {
      console.log(`✓ Updated role: ${roleDef.name}`)
    } else {
      console.log(`  Skipped (not found): ${roleDef.name}`)
    }
  }

  console.log('\nDone.')
  process.exit(0)
}

syncRolePermissions().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
