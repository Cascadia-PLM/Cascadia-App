// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

// The items API, split along its route families. Every module tags its
// handlers 'Items' and mounts at '/', so the composed app serves exactly the
// URLs the old monolithic items.ts did — paths are frozen v1 contract.
//
// Registration order is load-bearing in one place only: GET /search and
// GET /:id live in the same module (core.ts) in file order, because a
// single-segment param route would shadow the static one if it registered
// first. Two-segment paths (/:id/graph, /:itemId/files) cannot collide with
// /:id, so the mount order of the other modules is free.

import { Hono } from 'hono'
import core from './core'
import batch from './batch'
import checkout from './checkout'
import detail from './detail'
import graph from './graph'
import files from './files'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

// Re-exported for the enterprise-search results route, which gates the same way.
export { readableItemTypes } from './shared'

const app = new Hono()

app.route('/', core)
app.route('/', batch)
app.route('/', checkout)
app.route('/', detail)
app.route('/', graph)
app.route('/', files)

export default app
