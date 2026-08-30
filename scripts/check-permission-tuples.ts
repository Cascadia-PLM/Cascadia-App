// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assert the invariant: **a declared permission tuple is one a role can hold.**
 *
 *   npm run permissions:check
 *   npm run permissions:check -- --audience   # and who each tuple admits
 *
 * `apiHandler` refuses a request unless the caller's role grants the
 * `[resource, action]` pair the route declares, and nothing checked that the
 * pair was a pair a role can hold. A tuple no role grants is not a tight
 * route; it is a route nobody can call. It fails as a 403 — the same answer an
 * unauthorized caller gets — so it reads as working, and neither monitoring,
 * nor an integrator reading the OpenAPI document (tuples are not emitted
 * there), nor a test that mints a role to suit will say otherwise.
 *
 * `POST /files/:fileId/force-unlock` was that route. It charged
 * `['documents', 'manage']`, and `manage` sits on no item-type resource in
 * ROLE_DEFINITIONS, so it answered 403 to everyone including the
 * Administrator, from the day it was written until someone read it. Its own
 * suite did not miss the defect: it minted a custom role granting
 * `documents:manage` and then tested the route successfully. Reasoning over
 * ROLE_DEFINITIONS rather than over fixtures is what closes that gap.
 *
 * ROLE_DEFINITIONS is the whole universe of principals here, not a starting
 * point an operator grows out of. Roles are inserted in exactly one non-test
 * place — `scripts/seed-minimal.ts`, with `onConflictDoUpdate`, so a re-seed
 * also resets hand-edited grants — there is no role-creation route, and an API
 * key cannot widen what its user holds, since key scopes only narrow. What no
 * role grants, nobody can hold.
 *
 * The definitions are imported rather than parsed, so satisfiability is
 * decided by the same `hasPermission` the request path calls, `manage` acting
 * as a per-resource wildcard included. That works because
 * `lib/auth/permissions.ts` imports nothing; give it a database import and
 * this stops loading in the Lint job, which has no `DATABASE_URL`.
 *
 * ## Why an AST walk and not a grep
 *
 * `permission: [...]` appears inside `@example` docblocks in
 * `lib/api/handler.ts`, and `['documents', 'manage']` appears verbatim in the
 * comment on the route that used to charge it. A grep counts both. The
 * precedent is `scripts/check-annotated-bodies.mjs`, whose first attempt
 * "reported eight offenders where there were none"; comments and strings are
 * simply not in the tree this walks.
 *
 * ## What it covers
 *
 * Three literal shapes, on both surfaces that charge a tuple:
 *
 * - `apiHandler({ permission: ['documents', 'update'] }, …)` — the route option
 * - `requirePermission(request, 'system', 'manage')` — the second check a route
 *   charges inside the handler, on top of its declared tuple
 * - `{ resource: 'parts', action: 'read' }` — an AI/MCP tool's `PermissionSpec`,
 *   which `withPermissionAndAudit` enforces exactly as `apiHandler` does. A
 *   tool no model can call is the same defect on a different surface, and the
 *   sweep behind this check covered only routes.
 *
 * ## What it does not
 *
 * - **Computed tuples.** Sites charging `itemTypeToResource(item.itemType)` or
 *   `getResourceType(...)` carry no literal to check. They are counted in every
 *   run and listed by `--audience` rather than passed over in silence; covering
 *   them means enumerating the resource map's range through a dataflow pass.
 * - **The client half.** The defect above was two-sided: the tuple was
 *   unsatisfiable *and* the prop gating the button was passed by no call site.
 *   No server-side scan sees the second half.
 * - **Access scope.** A tuple can be perfectly satisfiable and the route still
 *   leak across programs. That is a different invariant.
 *
 * The inverse case — a tuple resolving to a *wider* audience than intended,
 * `manage` and `read` being one word apart in the source and a whole audience
 * apart at runtime — is not something a gate can decide. `--audience` prints
 * every distinct tuple with the roles it admits, which is the reviewable form
 * of that question.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import ts from 'typescript'

import {
  PERMISSION_ACTIONS,
  RESOURCE_TYPES,
  ROLE_DEFINITIONS,
  hasPermission,
  roleToDbFormat,
} from '../packages/core/src/lib/auth/permissions'
import type {
  PermissionAction,
  ResourceType,
} from '../packages/core/src/lib/auth/permissions'

/**
 * Comment marker that lets an unsatisfiable tuple through, with a reason.
 *
 * Nothing uses it, and that is the intended steady state — a tuple reserved
 * for a role the product cannot yet produce is arguable but hypothetical
 * today. It exists as a comment rather than a list in this file for the reason
 * the sibling check's does: the exemption and the reason for it belong beside
 * the route, where the next person to read that route will find them.
 */
const EXEMPTION = 'unsatisfiable-by-design:'

/** Which surface declared the tuple, for the report. */
export type SiteKind = 'route' | 'check' | 'tool'

export interface Site {
  file: string
  line: number
  resource: string
  action: string
  kind: SiteKind
  /** `POST /:fileId/force-unlock`, when the tuple sits in a route block. */
  label: string | null
  exempt: boolean
}

export interface ComputedSite {
  file: string
  line: number
  kind: SiteKind
  /** The expression standing where a literal would be. */
  snippet: string
}

export interface Findings {
  sites: Array<Site>
  computed: Array<ComputedSite>
}

const ROLES = Object.values(ROLE_DEFINITIONS).map((role) => ({
  name: role.name,
  grants: roleToDbFormat(role),
}))

const KNOWN_RESOURCES = new Set<string>(RESOURCE_TYPES)
const KNOWN_ACTIONS = new Set<string>(PERMISSION_ACTIONS)

/**
 * The roles that can hold `resource:action`.
 *
 * Decided by the predicate the request path calls, so `manage` acts as a
 * per-resource wildcard here for exactly the reason it does at runtime.
 */
export function holdersOf(resource: string, action: string): Array<string> {
  if (!KNOWN_RESOURCES.has(resource) || !KNOWN_ACTIONS.has(action)) return []
  return ROLES.filter((role) =>
    hasPermission(
      role.grants,
      resource as ResourceType,
      action as PermissionAction,
    ),
  ).map((role) => role.name)
}

function reasonFor(site: Site): string {
  if (!KNOWN_RESOURCES.has(site.resource)) {
    return `'${site.resource}' is not a ResourceType`
  }
  if (!KNOWN_ACTIONS.has(site.action)) {
    return `'${site.action}' is not a PermissionAction`
  }
  return 'granted by no role in ROLE_DEFINITIONS'
}

const SOURCE_FILE = /^(?:packages|apps)\/[^/]+\/src\/.*\.tsx?$/
const TEST_FILE = /\.(?:test|spec)\.tsx?$/
/**
 * Cheap gate: parsing the whole workspace to find ~300 sites is waste.
 *
 * Deliberately looser than the three shapes below — it decides only whether a
 * file is worth parsing, so it costs nothing to be wrong in the generous
 * direction and a silently skipped file to be wrong in the other.
 */
const MENTIONS_PERMISSION = /permission|resource\s*:/i

/**
 * Every non-test source file in the workspace, both editions.
 *
 * Matched by regex over the whole file list rather than by a pathspec glob.
 * The glob the sibling body check uses — routes directly under a package's
 * `src/server/routes` — misses the `routes/items` subdirectory, which carries
 * real tuples, and a copy of it here would have exempted that whole router
 * without saying so.
 */
function sourceFiles(): Array<string> {
  return execFileSync('git', ['ls-files'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((file) => SOURCE_FILE.test(file) && !TEST_FILE.test(file))
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function textOf(node: ts.Node | undefined): string | null {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null
}

function propertyName(node: ts.PropertyAssignment): string | null {
  const name = node.name
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function literalProperty(
  node: ts.ObjectLiteralExpression,
  key: string,
): string | null {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (propertyName(property) !== key) continue
    return textOf(property.initializer)
  }
  return null
}

function hasProperty(node: ts.ObjectLiteralExpression, key: string): boolean {
  return node.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) && propertyName(property) === key,
  )
}

function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return null
}

/** The top-level statement a node sits in — one route block, one declaration. */
function enclosingStatement(node: ts.Node): ts.Node {
  let current = node
  while (!ts.isSourceFile(current.parent)) current = current.parent
  return current
}

function routeLabel(statement: ts.Node): string | null {
  if (!ts.isExpressionStatement(statement)) return null
  const call = statement.expression
  if (!ts.isCallExpression(call)) return null
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  const method = callee.name.text.toUpperCase()
  if (!HTTP_METHODS.has(method)) return null
  const path = textOf(call.arguments[0])
  return path === null ? null : `${method} ${path}`
}

/** Every tuple one file declares, literal and computed. */
export function collect(file: string, text: string): Findings {
  const sites: Array<Site> = []
  const computed: Array<ComputedSite> = []

  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const record = (
    node: ts.Node,
    kind: SiteKind,
    resource: string,
    action: string,
  ): void => {
    const statement = enclosingStatement(node)
    sites.push({
      file,
      line: lineOf(node),
      resource,
      action,
      kind,
      label: routeLabel(statement),
      // Block-scoped like the sibling check's exemption: one comment anywhere
      // in the route block covers the tuples that block declares.
      exempt: statement.getFullText(source).includes(EXEMPTION),
    })
  }

  const note = (node: ts.Node, kind: SiteKind, snippet: ts.Node): void => {
    computed.push({
      file,
      line: lineOf(node),
      kind,
      snippet: snippet.getText(source).replace(/\s+/g, ' ').slice(0, 72),
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node) === 'permission') {
      const initializer = node.initializer
      if (ts.isArrayLiteralExpression(initializer)) {
        const resource = textOf(initializer.elements[0])
        const action = textOf(initializer.elements[1])
        if (resource !== null && action !== null) {
          record(node, 'route', resource, action)
        } else {
          note(node, 'route', initializer)
        }
      } else if (!ts.isObjectLiteralExpression(initializer)) {
        // An object literal here is a tool's PermissionSpec, which the third
        // pattern below reads — leave it rather than count it twice.
        note(node, 'route', initializer)
      }
    }

    if (ts.isCallExpression(node) && calleeName(node) === 'requirePermission') {
      const resource = textOf(node.arguments[1])
      const action = textOf(node.arguments[2])
      if (resource !== null && action !== null) {
        record(node, 'check', resource, action)
      } else {
        note(node, 'check', node)
      }
    }

    if (ts.isObjectLiteralExpression(node)) {
      const resource = literalProperty(node, 'resource')
      const action = literalProperty(node, 'action')
      // Discriminated on the values rather than on the wrapper's name: an
      // object pairing a known resource with a known action is a permission
      // spec wherever it is written, so a wrapper renamed tomorrow stays
      // covered. Over-matching is close to harmless — a literal only fails
      // this check when its pair is a real RBAC pair that no role holds.
      if (
        resource !== null &&
        action !== null &&
        KNOWN_RESOURCES.has(resource) &&
        KNOWN_ACTIONS.has(action)
      ) {
        record(node, 'tool', resource, action)
      } else if (
        hasProperty(node, 'resource') &&
        hasProperty(node, 'action') &&
        // One half literal and recognised is what says "permission spec"
        // rather than "some object with two common field names".
        ((resource !== null && KNOWN_RESOURCES.has(resource)) ||
          (action !== null && KNOWN_ACTIONS.has(action)))
      ) {
        note(node, 'tool', node)
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(source, visit)
  return { sites, computed }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function reportAudience(findings: Findings): void {
  const counts = new Map<string, number>()
  for (const site of findings.sites) {
    const key = `${site.resource}:${site.action}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const width = Math.max(...[...counts.keys()].map((key) => key.length))

  console.log('\nDeclared permission tuples, and the roles that admit them:\n')
  for (const [tuple, count] of [...counts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const [resource = '', action = ''] = tuple.split(':')
    const holders = holdersOf(resource, action)
    const seen = `${String(count).padStart(3)} ${count === 1 ? 'site ' : 'sites'}`
    const admits = holders.length > 0 ? holders.join(', ') : '— no role —'
    console.log(`  ${tuple.padEnd(width)}  ${seen}  ${admits}`)
  }

  if (findings.computed.length > 0) {
    console.log(
      `\nComputed tuples, out of this check's scope (${findings.computed.length}):\n`,
    )
    for (const site of findings.computed) {
      console.log(`  ${site.file}:${site.line}`)
      console.log(`    ${site.snippet}`)
    }
  }
  console.log('')
}

function main(): void {
  const findings: Findings = { sites: [], computed: [] }
  let parsed = 0

  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8')
    if (!MENTIONS_PERMISSION.test(text)) continue
    parsed++
    const found = collect(file, text)
    findings.sites.push(...found.sites)
    findings.computed.push(...found.computed)
  }

  if (process.argv.includes('--audience')) reportAudience(findings)

  const offenders = findings.sites.filter(
    (site) =>
      !site.exempt && holdersOf(site.resource, site.action).length === 0,
  )

  if (offenders.length > 0) {
    console.error('\n✗ Permission tuples that no role can hold:\n')
    for (const site of offenders) {
      console.error(`  ${site.file}:${site.line}  [${site.kind}]`)
      if (site.label !== null) console.error(`    ${site.label}`)
      console.error(`    ${site.resource}:${site.action} — ${reasonFor(site)}`)
    }
    console.error(
      [
        '',
        'A tuple no role grants is not a tight route, it is a route nobody can',
        'call: it answers 403 to everyone, the Administrator included, with the',
        'message an unauthorized caller gets. Either charge a tuple a role',
        'holds, or grant the action in packages/core/src/lib/auth/permissions.ts',
        'and sync existing databases with `npm run db:sync-roles`.',
        '',
        'If the tuple is genuinely reserved for a principal the product cannot',
        `yet produce, say so in a \`// ${EXEMPTION} <why>\` comment`,
        'inside the block that declares it.',
        '',
      ].join('\n'),
    )
    process.exit(1)
  }

  const exempt = findings.sites.filter((site) => site.exempt).length
  const declaring = new Set(findings.sites.map((site) => site.file)).size
  console.log(
    '\n✅ Every declared permission tuple is one a role can hold.\n' +
      `   ${plural(findings.sites.length, 'literal tuple')} across ` +
      `${plural(declaring, 'file')} (${parsed} parsed); ` +
      // Printed on every run, not only under --audience: a gap nobody is told
      // about reads as coverage.
      `${plural(findings.computed.length, 'computed tuple')} out of scope` +
      `${exempt > 0 ? `; ${plural(exempt, 'exemption')}` : ''}.\n`,
  )
}

// Run only as a CLI. The scanner is exported so its own test can plant a
// tuple and read back what this saw, rather than asserting on printed text.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
