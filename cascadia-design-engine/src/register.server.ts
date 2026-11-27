// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import designEngine from '@/server/routes/design-engine'
import cadSettings from '@/server/routes/cad-settings'
import partsCad from '@/server/routes/parts-cad'
import { initiateCollaborativeDesignTool } from '@/ai/tools/design-engine-tool'
import { registerTool } from '@/ai/tools/registry'
import { aiGenerationConfig } from '@/jobs/definitions/ai-generation/config'
import { assemblyComposeConfig } from '@/jobs/definitions/assembly-composition/config'
import { freecadScriptConfig } from '@/jobs/definitions/freecad-script/config'
import { mechanismGenerationConfig } from '@/jobs/definitions/mechanism-generation/config'
import { parametricGenerationConfig } from '@/jobs/definitions/parametric-generation/config'
import { aiGenerationHandler } from '@/jobs/node-handlers/ai-generation'
import { JobTypeRegistry } from '@/jobs/registry'
import { registerRoutes } from '@/api/route-registry'

let done = false

/** Attach design-engine to core. Idempotent; call before the first request. */
export function registerDesignEngine(): void {
  if (done) return
  done = true

  registerTool(initiateCollaborativeDesignTool)
  registerRoutes('api-root', '/api/v1/design-engine', designEngine)
}

let cadDone = false

/**
 * Attach the CAD-generation half of this package to core. Idempotent.
 *
 * A separate entry point from `registerDesignEngine` even though the two
 * live in one package: `modules.server.ts` calls both by name, and keeping
 * them apart leaves a clean seam along `cad-generation` should generative CAD
 * ever need to be composed on its own.
 */
export function registerCadGeneration(): void {
  if (cadDone) return
  cadDone = true

  // Both keep the URLs they already had.
  registerRoutes('admin', '/cad-settings', cadSettings)
  registerRoutes('parts', '/', partsCad)

  // Job *definitions* only — payload schemas, routing keys, retry policy. Both
  // the app and the worker need these: the app to dispatch and validate, the
  // worker to know what it is consuming. Handlers are separate, below.
  JobTypeRegistry.register(parametricGenerationConfig)
  JobTypeRegistry.register(mechanismGenerationConfig)
  JobTypeRegistry.register(assemblyComposeConfig)
  JobTypeRegistry.register(freecadScriptConfig)
  JobTypeRegistry.register(aiGenerationConfig)
}

/**
 * Attach this module's job handlers. **Worker entry points only.**
 *
 * Split from the registration above for the same reason core splits
 * `definitions/register` from `node-handlers/register`: a handler is the
 * implementation that actually runs a job, and the app has no business
 * importing one. Four of the five job types here are executed by Python
 * workers — the CadQuery generator and the FreeCAD runner — and have no Node
 * handler at all.
 */
export function registerCadGenerationWorker(): void {
  JobTypeRegistry.registerHandler(aiGenerationHandler)
}

/** Reset the once-guard. Tests only. */
export function resetDesignEngineRegistration(): void {
  done = false
}

/** Reset the CAD once-guard. Tests only. */
export function resetCadGenerationRegistration(): void {
  cadDone = false
}
