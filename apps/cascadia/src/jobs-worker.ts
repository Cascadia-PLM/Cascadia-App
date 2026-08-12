// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { runJobsWorker } from '@cascadia/core/jobs-worker-main'
import { registerModules, registerWorkerModules } from './modules.server'

// A job that votes on an approval must go through the same interceptors a
// request would, and this worker also executes module job types — hence the
// worker-only handler registration alongside.
registerModules()
registerWorkerModules()

runJobsWorker().catch((error: unknown) => {
  console.error('[Jobs Worker] Fatal error:', error)
  process.exit(1)
})
