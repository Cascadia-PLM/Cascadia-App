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
import designEngine from './routes/design-engine'
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
import mbom from './routes/mbom'
import parts from './routes/parts'
import programs from './routes/programs'
import relationships from './routes/relationships'
import reports from './routes/reports'
import requirements from './routes/requirements'
import roles from './routes/roles'
import setup from './routes/setup'
import sysml from './routes/sysml'
import tags from './routes/tags'
import tasks from './routes/tasks'
import testCases from './routes/test-cases'
import thread from './routes/thread'
import tools from './routes/tools'
import users from './routes/users'
import workInstructions from './routes/work-instructions'
import workOrders from './routes/work-orders'
import workflows from './routes/workflows'
import workspaces from './routes/workspaces'

const app = new Hono()

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
app.route('/api/v1/design-engine', designEngine)
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
app.route('/api/v1/mbom', mbom)
app.route('/api/v1/parts', parts)
app.route('/api/v1/programs', programs)
app.route('/api/v1/relationships', relationships)
app.route('/api/v1/reports', reports)
app.route('/api/v1/requirements', requirements)
app.route('/api/v1/roles', roles)
app.route('/api/v1/setup', setup)
app.route('/api/v1/sysml', sysml)
app.route('/api/v1/tags', tags)
app.route('/api/v1/tasks', tasks)
app.route('/api/v1/test-cases', testCases)
app.route('/api/v1/thread', thread)
app.route('/api/v1/tools', tools)
app.route('/api/v1/users', users)
app.route('/api/v1/work-instructions', workInstructions)
app.route('/api/v1/work-orders', workOrders)
app.route('/api/v1/workflows', workflows)
app.route('/api/v1/workspaces', workspaces)

// Machine-readable OpenAPI 3.1 document, regenerated from `apiHandler({ openapi })`
// metadata on every request. The committed snapshot lives at docs/api/openapi.v1.json.
app.get(
  '/openapi.json',
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: 'Cascadia API',
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

// In production, serve the Vite SPA build as static files
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }))
  // SPA fallback: serve index.html for all non-API routes
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

export default app
