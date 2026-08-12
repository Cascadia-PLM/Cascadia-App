// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import 'dotenv/config'
import { serve } from '@hono/node-server'
import { registerModules } from '../modules.server'

// Before the app import, not after. Route contributions mount while the routers
// are being built, so a static `import app from ...` — evaluated ahead of this
// line however far up the file it sits — would yield an app with the module's
// endpoints missing.
registerModules()

const { default: app } = await import('@cascadia/core/server/index')

const port = parseInt(process.env.API_PORT || '3001', 10)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Hono API server running on http://localhost:${info.port}`)
})
