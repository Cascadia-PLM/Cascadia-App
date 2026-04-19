/**
 * Build script for the Hono API server.
 *
 * Bundles src/server/prod.ts into .output/server/index.mjs so the production
 * container can run `node .output/server/index.mjs` without tsx and with
 * devDependencies omitted.
 */

import * as esbuild from 'esbuild'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const outfile = '.output/server/index.mjs'

const outDir = dirname(outfile)
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true })
}

await esbuild.build({
  entryPoints: ['src/server/prod.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  // CommonJS interop shim — many transitive deps use require()
  banner: {
    js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`,
  },
  // Packages that must be loaded from node_modules at runtime
  // (native bindings, dynamic requires, or pulled in by admin scripts only).
  external: [
    // Native modules
    'pg-native',
    '@node-rs/argon2',
    'better-sqlite3',
    'sharp',
    // AWS SDK — large, lazy-loaded by vault storage adapters
    '@aws-sdk/*',
    // Dynamic require()s that break ESM bundling
    'dotenv',
    'dotenv/*',
  ],
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'production',
    ),
  },
  loader: {
    '.node': 'copy',
  },
  logLevel: 'info',
})

console.log(`✅ Server built: ${outfile}`)
