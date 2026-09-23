// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { serve } from '@hono/node-server'
import { ItemTypeRegistry } from '@cascadia/api/lib/items/registry'
import { registerModules } from '../modules.server'

// Set production mode before importing app (affects static file serving)
process.env.NODE_ENV = 'production'

// Before the app import — see the note in `dev.ts`.
registerModules()

const { default: app } = await import('@cascadia/api/server')

// Runtime item-type configuration, before the first request rather than
// alongside it: `lifecycleDefinitionId` is a runtime value, so a request
// served ahead of this load resolves lifecycles from the shipped defaults
// instead of the assigned ones. A load that fails takes the boot down with
// it rather than serving a silently wrong configuration.
await ItemTypeRegistry.initialize()

// The domain event log assigns `seq` with a trigger drizzle-kit cannot
// create, so a push-provisioned database has none until a process ensures
// it. Done before serving: this process emits on its first write.
const [{ ensureDomainEventSequencing, sequenceUnsequencedEvents }, { db }] =
  await Promise.all([
    import('@cascadia/api/lib/events/sequencing'),
    import('@cascadia/api/lib/db'),
  ])
await ensureDomainEventSequencing(db)
// Anything written before the trigger existed committed with no seq, which the
// trigger never revisits: invisible to every consumer until it is given one.
await sequenceUnsequencedEvents(db)

// Core's own release follow-ups run here too, unless the deployment runs a
// jobs worker and says so with `EVENT_CONSUMERS_IN_APP=false`. Safe in both:
// `FOR UPDATE SKIP LOCKED` on the cursor row makes concurrent pollers
// mutually exclusive per consumer.
const { startAppEventConsumers } =
  await import('@cascadia/api/lib/extensions/app-consumers')
const stopEventConsumers = startAppEventConsumers()

const port = parseInt(process.env.PORT || '3000', 10)

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Cascadia server running on http://localhost:${info.port}`)
})

const { installGracefulShutdown } =
  await import('@cascadia/api/server/shutdown')
installGracefulShutdown({ server, stopEventConsumers })
