// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { freecadScriptPayloadSchema, freecadScriptResultSchema } from './types'
import type { FreecadScriptPayload, FreecadScriptResult } from './types'
import type { JobTypeConfig } from '@/jobs/types'

/**
 * Executed by the Python FreeCAD worker (`cascadia-workers-freecad-runner/`); there is
 * no Node handler. The timeout leaves room above the largest script budget an
 * admin can set (`CAD_GENERATION_LIMITS.scriptTimeoutSeconds`, 300 s) for
 * FreeCAD's own start-up and the vault write, so the worker's watchdog only
 * ever fires on a wedged process, never on a slow script that the harness
 * was about to time out itself.
 */
export const freecadScriptConfig: JobTypeConfig<
  FreecadScriptPayload,
  FreecadScriptResult
> = {
  type: 'generation.cad.freecad',
  label: 'FreeCAD Script Execution',
  routingKey: 'jobs.generation.cad.freecad',
  payloadSchema: freecadScriptPayloadSchema,
  resultSchema: freecadScriptResultSchema,
  timeout: 420000, // 7 minutes
  // One retry, for the worker dying under the job. A script error is not a
  // job failure (see types.ts), so this never re-runs a broken script.
  maxAttempts: 2,
  retryDelays: [5000],
  priority: 'high',
}
