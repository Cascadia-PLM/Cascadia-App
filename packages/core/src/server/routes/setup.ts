// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { SettingKeys } from '@/lib/config/SettingKeys'
import { SettingsService } from '@/lib/config/SettingsService'
import { CatalogSeedService } from '@/lib/services/CatalogSeedService'

const adapt = tagged('Setup')

const app = new Hono()

// Step flags added after the wizard shipped default to false so progress
// persisted by an older build still validates (and so a stale client that
// omits the key doesn't get a 400).
const setupProgressSchema = z.object({
  orgInfo: z.boolean(),
  users: z.boolean(),
  ai: z.boolean(),
  programs: z.boolean(),
  tools: z.boolean().default(false),
  dismissedAt: z.string().nullable(),
})

type SetupProgress = z.infer<typeof setupProgressSchema>

const DEFAULT_PROGRESS: SetupProgress = {
  orgInfo: false,
  users: false,
  ai: false,
  programs: false,
  tools: false,
  dismissedAt: null,
}

// GET /api/v1/setup/status
app.get(
  '/status',
  adapt(
    apiHandler({}, async ({ user }) => {
      const [completedRaw, stored, isAdmin] = await Promise.all([
        SettingsService.getValue(SettingKeys.SETUP_COMPLETED),
        SettingsService.getJsonValue<Partial<SetupProgress>>(
          SettingKeys.SETUP_PROGRESS,
        ),
        AccessControlService.hasCrossProgramAccess(user.id),
      ])

      return {
        completed: completedRaw === 'true',
        isAdmin,
        progress: stored
          ? { ...DEFAULT_PROGRESS, ...stored }
          : DEFAULT_PROGRESS,
      }
    }),
  ),
)

// POST /api/v1/setup/progress
app.post(
  '/progress',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: setupProgressSchema },
      // The hand-rolled `safeParse` + issue-mapping this replaces produced
      // the same 400 envelope `handleApiError` builds from a ZodError.
      async ({ body, user }) => {
        await SettingsService.setJsonValue(
          SettingKeys.SETUP_PROGRESS,
          body,
          user.id,
          'First-time setup wizard progress',
        )

        return { progress: body }
      },
    ),
  ),
)

// POST /api/v1/setup/complete
app.post(
  '/complete',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ user }) => {
      await SettingsService.setValue(
        SettingKeys.SETUP_COMPLETED,
        'true',
        user.id,
        'First-time setup wizard completion flag',
      )

      return { completed: true }
    }),
  ),
)

// POST /api/v1/setup/skip
//
// Functionally identical to /complete; kept distinct for audit clarity so
// dismissals can be told apart from intentional completions.
app.post(
  '/skip',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async ({ user }) => {
      await SettingsService.setValue(
        SettingKeys.SETUP_COMPLETED,
        'true',
        user.id,
        'First-time setup wizard skipped',
      )

      return { completed: true }
    }),
  ),
)

// POST /api/v1/setup/seed-catalog
app.post(
  '/seed-catalog',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async () => {
      const result = await CatalogSeedService.run()
      return result
    }),
  ),
)

export default app
