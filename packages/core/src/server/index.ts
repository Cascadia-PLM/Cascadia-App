// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { openAPIRouteHandler } from 'hono-openapi'
import { Scalar } from '@scalar/hono-api-reference'

import admin from './routes/admin'
import ai from './routes/ai'
import auth from './routes/auth'
import branchItems from './routes/branch-items'
import branches from './routes/branches'
import changeOrders from './routes/change-orders'
import commits from './routes/commits'
import dashboard from './routes/dashboard'
import designs from './routes/designs'
import documents from './routes/documents'
import enterpriseSearch from './routes/enterprise-search'
import files from './routes/files'
import health from './routes/health'
import importRoutes from './routes/import'
import issues from './routes/issues'
import items from './routes/items'
import jobs from './routes/jobs'
import lifecycles from './routes/lifecycles'
import manufacturerPartsRoutes from './routes/manufacturer-parts'
import mbom from './routes/mbom'
import mcp from './routes/mcp'
import packages from './routes/packages'
import parts from './routes/parts'
import physicalPartsRoutes from './routes/physical-parts'
import programs from './routes/programs'
import relationships from './routes/relationships'
import reports from './routes/reports'
import requirements from './routes/requirements'
import roles from './routes/roles'
import setup from './routes/setup'
import software from './routes/software'
import sysml from './routes/sysml'
import tags from './routes/tags'
import tasks from './routes/tasks'
import testCases from './routes/test-cases'
import testPlans from './routes/test-plans'
import thread from './routes/thread'
import tools from './routes/tools'
import users from './routes/users'
import workInstructions from './routes/work-instructions'
import workOrders from './routes/work-orders'
import workflows from './routes/workflows'
import workspaces from './routes/workspaces'
import { ERROR_COMPONENTS } from '@/lib/api/openapi-helpers'
import { mountRoutes } from '@/lib/api/route-registry'
import { buildPreflightResponse } from '@/lib/api/cors'

const app = new Hono()

// CORS preflight, ahead of every route mount because none of them can answer
// it: route modules register concrete methods (app.get, app.post, …), so Hono
// dispatches OPTIONS to nothing and a browser's preflight would 404 with no
// Access-Control-* headers — which is what made CORS_ALLOWED_ORIGINS
// unusable from a browser however it was set.
//
// It answers 204 for every /api/* path, including /api/mcp and paths that do
// not exist. That is harmless: a preflight asks about policy, not about the
// resource, and the real request that follows is still routed — or 404s —
// normally. A disallowed origin gets a 204 with no Access-Control-* headers
// and the browser blocks the real request. See lib/api/cors.ts.
app.options('/api/*', (c) => buildPreflightResponse(c.req.raw))

// Mount route groups under the v1 prefix. The OpenAPI document published at
// /openapi.json is the frozen contract for v1; breaking changes bump to /api/v2.
app.route('/api/v1/admin', admin)
app.route('/api/v1/ai', ai)
app.route('/api/v1/auth', auth)
app.route('/api/v1/branch-items', branchItems)
app.route('/api/v1/branches', branches)
app.route('/api/v1/change-orders', changeOrders)
app.route('/api/v1/commits', commits)
app.route('/api/v1/dashboard', dashboard)
app.route('/api/v1/designs', designs)
app.route('/api/v1/documents', documents)
app.route('/api/v1/enterprise-search', enterpriseSearch)
app.route('/api/v1/files', files)
app.route('/api/v1/health', health)
app.route('/api/v1/import', importRoutes)
app.route('/api/v1/issues', issues)
app.route('/api/v1/items', items)
app.route('/api/v1/jobs', jobs)
app.route('/api/v1/lifecycles', lifecycles)
app.route('/api/v1/manufacturer-parts', manufacturerPartsRoutes)
app.route('/api/v1/mbom', mbom)
// MCP endpoint speaks JSON-RPC (Streamable HTTP), not the REST envelope —
// mounted outside the frozen /api/v1 contract. See docs/features/mcp.md.
app.route('/api/mcp', mcp)
app.route('/api/v1/packages', packages)
app.route('/api/v1/parts', parts)
app.route('/api/v1/physical-parts', physicalPartsRoutes)
app.route('/api/v1/programs', programs)
app.route('/api/v1/relationships', relationships)
app.route('/api/v1/reports', reports)
app.route('/api/v1/requirements', requirements)
app.route('/api/v1/roles', roles)
app.route('/api/v1/setup', setup)
app.route('/api/v1/software', software)
app.route('/api/v1/sysml', sysml)
app.route('/api/v1/tags', tags)
app.route('/api/v1/tasks', tasks)
app.route('/api/v1/test-cases', testCases)
app.route('/api/v1/test-plans', testPlans)
app.route('/api/v1/thread', thread)
app.route('/api/v1/tools', tools)
app.route('/api/v1/users', users)
app.route('/api/v1/work-instructions', workInstructions)
app.route('/api/v1/work-orders', workOrders)
app.route('/api/v1/workflows', workflows)
app.route('/api/v1/workspaces', workspaces)

// Whole resources owned by an optional package mount here — the collaborative
// design engine and the signature manifest, today. Nothing is registered on a
// core-only build, which is what lets this file compile with the proprietary
// directories absent.
mountRoutes(app, 'api-root')

// Machine-readable OpenAPI 3.1 document, regenerated from `apiHandler({ openapi })`
// metadata on every request. The committed snapshot lives at docs/api/openapi.v1.json.
app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'Cascadia API',
        // The API *contract* version, not the product version: v1 is frozen
        // (docs/api/README.md), so this stays 1.0.0 across product releases.
        // The product version lives in APP_VERSION and /api/v1/health.
        version: '1.0.0',
        description:
          'Code-first PLM. ECO-as-Branch versioning. v1 surface is frozen; ' +
          'additive changes only until v2 is cut.',
      },
      servers: [{ url: '/', description: 'This server' }],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: 'session',
          },
          apiKey: { type: 'http', scheme: 'bearer' },
        },
        // The error envelope, defined once. Every route references these
        // instead of inlining them — see ERROR_COMPONENTS.
        ...ERROR_COMPONENTS,
      },
      security: [{ sessionCookie: [] }, { apiKey: [] }],
    },
  }),
)

// Human-readable docs UI at /api/docs.
app.get(
  '/api/docs',
  Scalar({
    url: '/openapi.json',
    pageTitle: 'Cascadia API Reference',
  }),
)

// In production, serve the Vite SPA build as static files.
//
// The client build has been per-edition since the Phase 2 split — `dist/<app>/`,
// not `dist/` — so the static root has to name the app or every asset 404s and
// `/` with them. The API kept answering, which is what hid this: the container
// reported healthy while serving no UI at all. `APP` is set by
// `scripts/serve.mjs` and by `docker/app.Dockerfile`; the bare fallback keeps a
// flat build working.
const DIST = process.env.APP ? `./dist/${process.env.APP}` : './dist'
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: DIST }))
  // SPA fallback: serve index.html for all non-API routes
  app.get('*', serveStatic({ path: `${DIST}/index.html` }))
}

export default app
