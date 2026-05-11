// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { SettingKeys } from '@/lib/config/SettingKeys'
import { SettingsService } from '@/lib/config/SettingsService'
import { CatalogSeedService } from '@/lib/services/CatalogSeedService'
import { ValidationError } from '@/lib/errors'

const adapt = tagged('Setup')

const app = new Hono()

const setupProgressSchema = z.object({
  orgInfo: z.boolean(),
  users: z.boolean(),
  ai: z.boolean(),
  programs: z.boolean(),
  dismissedAt: z.string().nullable(),
})

type SetupProgress = z.infer<typeof setupProgressSchema>

const DEFAULT_PROGRESS: SetupProgress = {
  orgInfo: false,
  users: false,
  ai: false,
  programs: false,
  dismissedAt: null,
}

// GET /api/v1/setup/status
app.get(
  '/status',
  adapt(
    apiHandler({}, async ({ user }) => {
      const [completedRaw, progress, isGlobalAdmin] = await Promise.all([
        SettingsService.getValue(SettingKeys.SETUP_COMPLETED),
        SettingsService.getJsonValue<SetupProgress>(SettingKeys.SETUP_PROGRESS),
        AccessControlService.isGlobalAdmin(user.id),
      ])

      return {
        completed: completedRaw === 'true',
        isGlobalAdmin,
        progress: progress ?? DEFAULT_PROGRESS,
      }
    }),
  ),
)

// POST /api/v1/setup/progress
app.post(
  '/progress',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'] },
      async ({ request, user }) => {
        const body = await request.json()
        const parsed = setupProgressSchema.safeParse(body)
        if (!parsed.success) {
          throw new ValidationError(
            'Invalid setup progress payload',
            parsed.error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
              code: issue.code,
            })),
          )
        }

        await SettingsService.setJsonValue(
          SettingKeys.SETUP_PROGRESS,
          parsed.data,
          user.id,
          'First-time setup wizard progress',
        )

        return { progress: parsed.data }
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
