// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assert the invariant: **a documented request body is an enforced one.**
 *
 *   npm run bodies:check
 *
 * Forty-three routes declared `openapi.request.body.schema` and none of them
 * ran it. The document said `PUT /parts/:id` takes a `partUpdateSchema`; the
 * handler took whatever it was sent. An integrator reading the spec and a
 * caller probing the endpoint learned two different contracts, and the schema
 * drifted from the handler for as long as nothing compared them.
 *
 * VAL-2 gave `apiHandler` a `body:` option that both validates and documents,
 * so the two cannot disagree. This says: if a route annotates a body, it must
 * either declare `body:` or say why not.
 *
 * Three routes legitimately cannot, and carry a `documented-not-enforced:`
 * comment with the reason — a multipart upload, a batch endpoint whose
 * contract is per-line rejection, and a create route whose real check is a
 * per-item-type parse that raises a better error than a union would.
 *
 * Deliberately a parser of route blocks rather than a grep: `body:` appears in
 * an annotation, in an option, and in a handler's destructuring, and a plain
 * grep cannot tell those apart — the first attempt at this check reported
 * eight offenders where there were none.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROUTE_START = /^app\.(get|post|put|patch|delete)\($/
const ANNOTATED = /body: \{\s*$|body: \{ schema: \w+/
const ENFORCED = /^\s*body: [\w.]+(\.optional\(\))?,\s*$/
const EXEMPTION = 'documented-not-enforced:'

function routeFiles() {
  return execFileSync(
    'git',
    ['ls-files', 'packages/*/src/server/routes/*.ts'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((f) => f && !f.endsWith('.test.ts'))
}

const offenders = []
for (const file of routeFiles()) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const starts = lines.flatMap((l, i) => (ROUTE_START.test(l) ? [i] : []))

  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? lines.length
    const block = lines.slice(start, end)
    if (!block.some((l) => ANNOTATED.test(l))) continue
    if (block.some((l) => ENFORCED.test(l))) continue
    if (block.some((l) => l.includes(EXEMPTION))) continue

    const route = /^\s*'([^']+)',?$/.exec(block[1])?.[1] ?? '?'
    offenders.push({
      file,
      route: `${lines[start].slice(4, -1).toUpperCase()} ${route}`,
      line: start + 1,
    })
  }
}

if (offenders.length > 0) {
  console.error('\n✗ Routes document a request body without enforcing it:\n')
  for (const { file, route, line } of offenders) {
    console.error(`  ${file}:${line}`)
    console.error(`    ${route}`)
  }
  console.error(
    [
      '',
      'Move the schema onto apiHandler’s `body:` option and delete the',
      'in-handler `request.json()`. One object then both validates and',
      'documents, so the spec cannot promise a shape the route does not keep.',
      '',
      `If the route genuinely cannot — multipart, or a batch whose contract is`,
      `per-line rejection — say so in a \`// ${EXEMPTION} <why>\` comment.`,
      '',
    ].join('\n'),
  )
  process.exit(1)
}

console.log(
  `\n✅ Every documented request body is enforced. (${routeFiles().length} route files scanned)\n`,
)
