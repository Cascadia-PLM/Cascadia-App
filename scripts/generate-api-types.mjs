// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Generate TypeScript types from the committed OpenAPI snapshot.
 *
 *   npm run types:openapi          # writes packages/core/src/lib/api/openapi-types.gen.ts
 *   npm run types:openapi:check    # fails when the committed file is stale
 *
 * Mirrors the snapshot's own --check convention: CI runs the check right
 * after `openapi:check`, so one job owns contract drift end to end
 * (routes → snapshot → generated types).
 *
 * The types are generated from the COMMUNITY view of the spec in both trees:
 * in this repository the module endpoints (OPENAPI_DROP_PATHS from
 * publish/overlay.mjs) are filtered out before generation, and in the
 * published repository the committed snapshot never had them — so the
 * committed .gen.ts is byte-identical across editions and the publish
 * pipeline copies it as-is. Module packages type their own routes; core's
 * generated surface must not leak their shapes.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import openapiTS, { astToString } from 'openapi-typescript'

const REPO = process.cwd()
const SNAPSHOT = resolve(REPO, 'docs', 'api', 'openapi.v1.json')
const OUT = resolve(
  REPO,
  'packages',
  'core',
  'src',
  'lib',
  'api',
  'openapi-types.gen.ts',
)
const CHECK = process.argv.includes('--check')

// The module endpoints to filter before generating. In the published tree
// publish/overlay.mjs does not exist — and its snapshot already lacks these
// paths — so an empty list is exactly right there.
let dropPaths = []
try {
  ;({ OPENAPI_DROP_PATHS: dropPaths } = await import('../publish/overlay.mjs'))
} catch {
  dropPaths = []
}

const spec = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
spec.paths = Object.fromEntries(
  Object.entries(spec.paths).filter(([path]) => !dropPaths.includes(path)),
)

const ast = await openapiTS(spec)

const header = `// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * GENERATED FILE — do not edit.
 *
 * Derived from docs/api/openapi.v1.json (community view) by
 * scripts/generate-api-types.mjs. Regenerate with \`npm run types:openapi\`;
 * CI fails on drift via \`npm run types:openapi:check\`.
 *
 * Coverage note: the snapshot documents success-response schemas on a
 * minority of operations, so most \`paths\` entries carry only error
 * envelopes for now. As the API workstream annotates \`responses\` on more
 * routes, their types appear here on the next regeneration — consume them
 * via the helpers in ./typed.ts.
 */

`

const generated = header + astToString(ast)

if (CHECK) {
  const committed = readFileSync(OUT, 'utf8')
  if (committed !== generated) {
    console.error(
      '✗ packages/core/src/lib/api/openapi-types.gen.ts is stale.\n' +
        '  The OpenAPI snapshot changed without regenerating the types.\n' +
        '  Run: npm run types:openapi  — and commit the result.',
    )
    process.exit(1)
  }
  console.log('✅ Generated API types match the OpenAPI snapshot.')
} else {
  writeFileSync(OUT, generated)
  console.log(`Wrote ${OUT}`)
}
