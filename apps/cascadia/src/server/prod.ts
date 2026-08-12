// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { serve } from '@hono/node-server'
import { registerModules } from '../modules.server'

// Set production mode before importing app (affects static file serving)
process.env.NODE_ENV = 'production'

// Before the app import — see the note in `dev.ts`.
registerModules()

const { default: app } = await import('@cascadia/core/server/index')

const port = parseInt(process.env.PORT || '3000', 10)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Cascadia server running on http://localhost:${info.port}`)
})
