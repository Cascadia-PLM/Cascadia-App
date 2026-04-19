import { defineConfig } from 'vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    TanStackRouterVite(),
    viteReact(),
  ],
  server: {
    port: 3000,
    proxy: {
      // Proxy API requests to the Hono server in dev mode.
      // Keep the original Host header (localhost:3000) so Hono's CSRF
      // origin check sees the same origin the browser sent.
      '/api': {
        target: 'http://localhost:3001',
      },
    },
  },
})

export default config
