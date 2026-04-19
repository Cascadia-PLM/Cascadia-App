/**
 * Build script for the jobs worker
 *
 * Bundles src/jobs-worker.ts into .output/server/jobs-worker.mjs
 * for standalone execution in Docker containers.
 */

import * as esbuild from 'esbuild'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const outfile = '.output/server/jobs-worker.mjs'

// Ensure output directory exists
const outDir = dirname(outfile)
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true })
}

await esbuild.build({
  entryPoints: ['src/jobs-worker.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  // Banner to support require() in ESM for packages that need it
  banner: {
    js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`,
  },
  // Externalize packages that should come from node_modules at runtime
  external: [
    // Native modules
    'pg-native',
    '@node-rs/argon2',
    // Packages that have native bindings or should be loaded at runtime
    'better-sqlite3',
    'sharp',
    // AWS SDK (loaded at runtime)
    '@aws-sdk/*',
    // Packages with dynamic requires that break ESM bundling
    'dotenv',
    'dotenv/*',
  ],
  // Source maps for debugging
  sourcemap: true,
  // Minify for production
  minify: process.env.NODE_ENV === 'production',
  // Define environment
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'production',
    ),
  },
  // Handle .node binary files
  loader: {
    '.node': 'copy',
  },
  // Log level
  logLevel: 'info',
})

console.log(`✅ Jobs worker built: ${outfile}`)
