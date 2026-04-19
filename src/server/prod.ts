import { serve } from '@hono/node-server'

// Set production mode before importing app (affects static file serving)
process.env.NODE_ENV = 'production'

const { default: app } = await import('./index')

const port = parseInt(process.env.PORT || '3000', 10)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Cascadia server running on http://localhost:${info.port}`)
})
