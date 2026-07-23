/**
 * Shared pieces of the esbuild Node bundles
 * (.output/server/index.mjs and .output/server/jobs-worker.mjs).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * CommonJS interop shim — many transitive deps call require() at runtime, which
 * does not exist in an ESM bundle, so we recreate it from import.meta.url.
 *
 * The import is aliased on purpose. esbuild treats a banner as opaque text: it
 * never parses it, so it cannot rename around it. Any bundled dependency whose
 * ESM entry starts with `import { createRequire } from 'module'` gets that
 * import emitted verbatim into the same bundle, and the two top-level bindings
 * collide:
 *
 *   SyntaxError: Identifier 'createRequire' has already been declared
 *
 * fflate/esm/index.mjs does exactly this, which broke every production boot.
 * Importing under a private alias keeps the banner collision-proof regardless
 * of what a dependency does.
 *
 * The `require` const itself needs no alias: esbuild knows `require` is
 * significant on platform: 'node' and renames a dependency's own top-level
 * `require` binding out of the way (fflate's becomes `require2`).
 */
export const cjsInteropBanner = `
import { createRequire as __cascadiaCreateRequire } from 'node:module';
const require = __cascadiaCreateRequire(import.meta.url);
`

/**
 * Parse the emitted bundle the way Node will on boot.
 *
 * esbuild cannot detect banner/bundle collisions like the one above — the build
 * succeeds and the breakage only surfaces when the server starts. This turns
 * that into a build failure.
 */
export async function assertBundleParses(outfile) {
  try {
    await execFileAsync(process.execPath, ['--check', outfile])
  } catch (error) {
    console.error(
      `\n❌ ${outfile} is not valid ESM — it would fail to boot:\n\n${
        error.stderr || error.message
      }`,
    )
    process.exit(1)
  }
}
