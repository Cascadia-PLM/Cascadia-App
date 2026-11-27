// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import type { CadGenerationConfig } from '@/cad-generation/settings-types'
import { tagged } from '@/server/adapter'
import {
  CAD_GENERATION_LIMITS,
  resolveCadGenerationConfig,
} from '@/cad-generation/settings-types'
import { loadCadGenerationConfig } from '@/cad-generation/settings'
import {
  FREECAD_WORKER_SERVICE,
  executeFreecadScript,
} from '@/cad-generation/freecad-execute'
import { describeGeometry } from '@/cad-generation/freecad-agent'
import { apiHandler } from '@/api/handler'
import { isAIEnabled } from '@/ai/adapters'

import { SettingsService } from '@/config/SettingsService'
import { SettingKeys } from '@/config/SettingKeys'

/**
 * The stored AI CAD generation configuration. Ranges are the same limits the
 * resolver clamps to, so a value the form cannot submit is also a value the
 * pipeline never runs with.
 */
const cadSettingsSchema = z.object({
  enabled: z.boolean(),
  maxIterations: z
    .number()
    .int()
    .min(CAD_GENERATION_LIMITS.maxIterations.min)
    .max(CAD_GENERATION_LIMITS.maxIterations.max)
    .optional(),
  scriptTimeoutSeconds: z
    .number()
    .int()
    .min(CAD_GENERATION_LIMITS.scriptTimeoutSeconds.min)
    .max(CAD_GENERATION_LIMITS.scriptTimeoutSeconds.max)
    .optional(),
})

/**
 * AI CAD generation settings, contributed to the admin surface.
 *
 * These endpoints used to hold a second vendor's API key beside the AI
 * provider's. Generation now rides the AI provider itself and an in-house
 * FreeCAD worker, so what is left to administer is the switch, the agent's
 * budget, and a smoke test that proves a worker is actually consuming the
 * queue. They stay mounted onto `/api/v1/admin` through the route registry,
 * so the URLs are exactly what they were; an instance without this package
 * simply has no such endpoints.
 *
 * The `Admin` tag is kept deliberately: these really are admin endpoints, and
 * retagging them would churn the frozen v1 snapshot for no benefit.
 */
const adapt = tagged('Admin')

const app = new Hono()

/** What a smoke test asks the worker to build: unmistakable, and instant. */
const SMOKE_TEST_SCRIPT = [
  'import Part',
  'from FreeCAD import Base',
  '',
  '# A 10 mm cube centred on the origin, base on Z=0.',
  'result = Part.makeBox(10, 10, 10, Base.Vector(-5, -5, 0))',
  '',
].join('\n')

/** How long the smoke test waits for a worker before calling it absent. */
const SMOKE_TEST_WAIT_MS = 30_000

// GET /api/v1/admin/cad-settings
app.get(
  '/',
  adapt(
    apiHandler({ permission: ['system', 'manage'] }, async () => {
      const settings = resolveCadGenerationConfig(
        await loadCadGenerationConfig(),
      )
      return {
        settings,
        // Whether any AI provider resolves — the agent has nothing to call
        // without one, and the card says so instead of letting the first
        // generation discover it.
        aiConfigured: await isAIEnabled(),
      }
    }),
  ),
)

// POST /api/v1/admin/cad-settings
app.post(
  '/',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'], body: cadSettingsSchema },
      async ({ body, user }) => {
        const blob: CadGenerationConfig = {
          enabled: body.enabled,
          maxIterations: body.maxIterations,
          scriptTimeoutSeconds: body.scriptTimeoutSeconds,
        }
        await SettingsService.setJsonValue(
          SettingKeys.CAD_GENERATION,
          blob,
          user.id,
          'AI CAD generation settings',
        )

        return { settings: resolveCadGenerationConfig(blob) }
      },
    ),
  ),
)

// POST /api/v1/admin/cad-settings/test
//
// Proves the whole execution path end to end: a job leaves through RabbitMQ,
// a FreeCAD worker claims it, FreeCAD builds a cube, and the report comes
// back. Nothing is stored. A queue nobody consumes is the failure this
// exists to surface, so the wait is short and the timeout message says what
// to check.
app.post(
  '/test',
  adapt(
    apiHandler(
      { permission: ['system', 'manage'] },
      async ({ request, user }) => {
        try {
          const report = await executeFreecadScript({
            script: SMOKE_TEST_SCRIPT,
            partName: 'freecad-smoke-test',
            userId: user.id,
            persist: false,
            timeoutMs: 20_000,
            maxWaitMs: SMOKE_TEST_WAIT_MS,
            pollIntervalMs: 500,
            signal: request.signal,
          })

          if (!report.ok) {
            return unavailable(
              `The FreeCAD worker ran the test script but it failed: ${report.errorMessage ?? report.issues[0] ?? 'unknown error'}`,
            )
          }

          return {
            success: true,
            message: `FreeCAD ${report.freecadVersion ?? '(version unknown)'} built the test part (${describeGeometry(report.geometry)}) in ${(report.executionTimeMs / 1000).toFixed(1)}s.`,
            freecadVersion: report.freecadVersion,
            executionTimeMs: report.executionTimeMs,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return unavailable(
            message.startsWith(FREECAD_WORKER_SERVICE)
              ? message
              : `${FREECAD_WORKER_SERVICE}: ${message}`,
          )
        }
      },
    ),
  ),
)

/** A 503 in the error envelope the admin card already knows how to read. */
function unavailable(message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: 'CONNECTION_ERROR', message } }),
    { status: 503, headers: { 'Content-Type': 'application/json' } },
  )
}

export default app
