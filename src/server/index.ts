import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'

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

// Mount route groups
app.route('/api/admin', admin)
app.route('/api/ai', ai)
app.route('/api/auth', auth)
app.route('/api/branch-items', branchItems)
app.route('/api/branches', branches)
app.route('/api/change-orders', changeOrders)
app.route('/api/commits', commits)
app.route('/api/dashboard', dashboard)
app.route('/api/design-engine', designEngine)
app.route('/api/designs', designs)
app.route('/api/documents', documents)
app.route('/api/enterprise-search', enterpriseSearch)
app.route('/api/files', files)
app.route('/api/health', health)
app.route('/api/import', importRoutes)
app.route('/api/issues', issues)
app.route('/api/items', items)
app.route('/api/jobs', jobs)
app.route('/api/lifecycles', lifecycles)
app.route('/api/mbom', mbom)
app.route('/api/parts', parts)
app.route('/api/programs', programs)
app.route('/api/relationships', relationships)
app.route('/api/reports', reports)
app.route('/api/requirements', requirements)
app.route('/api/roles', roles)
app.route('/api/sysml', sysml)
app.route('/api/tags', tags)
app.route('/api/tasks', tasks)
app.route('/api/test-cases', testCases)
app.route('/api/thread', thread)
app.route('/api/tools', tools)
app.route('/api/users', users)
app.route('/api/work-instructions', workInstructions)
app.route('/api/work-orders', workOrders)
app.route('/api/workflows', workflows)
app.route('/api/workspaces', workspaces)

// In production, serve the Vite SPA build as static files
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist' }))
  // SPA fallback: serve index.html for all non-API routes
  app.get('*', serveStatic({ path: './dist/index.html' }))
}

export default app
