// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The scanner behind `npm run permissions:check`.
 *
 * Security gate, and the one shape of test that can fail usefully here: a lint
 * that quietly stops matching is indistinguishable from a clean tree, which is
 * the exact failure the check exists to prevent one level up. So this plants
 * tuples and reads back what the scanner saw, rather than asserting on the
 * text it prints.
 *
 * Run: npx vitest run scripts/check-permission-tuples.test.ts
 */

import { describe, expect, it } from 'vitest'
import { collect, holdersOf } from './check-permission-tuples'

/** Tuple strings for what a source fragment declares, in source order. */
function tuplesIn(source: string): Array<string> {
  return collect('fixture.ts', source).sites.map(
    (site) => `${site.resource}:${site.action}`,
  )
}

describe('holdersOf', () => {
  it('names the roles that can hold a tuple', () => {
    expect(holdersOf('system', 'manage')).toEqual(['Administrator'])
  })

  it('reads `manage` as the per-resource wildcard the request path reads', () => {
    // Power User's workflows grant is ['read', 'manage'] and lists no
    // 'create'. hasPermission() still admits it, so this check must too —
    // deciding satisfiability by set membership would report a live route
    // dead.
    expect(holdersOf('workflows', 'create')).toContain('Power User')
  })

  it('finds nobody for an action no role grants on that resource', () => {
    // The tuple that motivated the check: `manage` sits on no item-type
    // resource, so the route charging it was unreachable by anyone.
    expect(holdersOf('documents', 'manage')).toEqual([])
  })

  it('finds nobody for a resource that is not a ResourceType', () => {
    expect(holdersOf('document', 'read')).toEqual([])
  })
})

describe('collect', () => {
  it('reads a route option tuple, with the route it belongs to', () => {
    const [site] = collect(
      'fixture.ts',
      `app.post(
  '/:fileId/force-unlock',
  adapt(apiHandler({ permission: ['documents', 'manage'] }, handler)),
)`,
    ).sites

    expect(site).toMatchObject({
      resource: 'documents',
      action: 'manage',
      kind: 'route',
      label: 'POST /:fileId/force-unlock',
      exempt: false,
    })
  })

  it('reads an in-handler requirePermission check', () => {
    expect(
      tuplesIn(`async function handler(request) {
  await requirePermission(request, 'system', 'manage')
}`),
    ).toEqual(['system:manage'])
  })

  it("reads an AI tool's PermissionSpec", () => {
    expect(
      tuplesIn(`export const h = withPermissionAndAudit(
  'search_items',
  { resource: 'parts', action: 'read' },
  impl,
)`),
    ).toEqual(['parts:read'])
  })

  it('ignores a tuple written in a comment', () => {
    // Both of these are live in the tree: `lib/api/handler.ts` documents the
    // option in an @example block, and the route that used to charge
    // documents:manage explains itself by quoting the tuple. A grep counts
    // both and reports offenders that do not exist.
    expect(
      tuplesIn(`/**
 * @example
 * apiHandler({ permission: ['parts', 'read'] }, fn)
 */
// The route used to declare \`['documents', 'manage']\`, which no role holds.
export const nothing = 1`),
    ).toEqual([])
  })

  it('ignores a tuple written in a string', () => {
    expect(
      tuplesIn(`const doc = "permission: ['documents', 'manage']"`),
    ).toEqual([])
  })

  it('honours an exemption comment anywhere in the declaring block', () => {
    const [site] = collect(
      'fixture.ts',
      `// unsatisfiable-by-design: reserved for a role the product cannot yet make
app.post('/x', adapt(apiHandler({ permission: ['documents', 'manage'] }, fn)))`,
    ).sites

    expect(site?.exempt).toBe(true)
  })

  it('does not let one block’s exemption cover the next block', () => {
    const sites = collect(
      'fixture.ts',
      `// unsatisfiable-by-design: this one only
app.post('/a', adapt(apiHandler({ permission: ['documents', 'manage'] }, fn)))
app.post('/b', adapt(apiHandler({ permission: ['documents', 'manage'] }, fn)))`,
    ).sites

    expect(sites.map((site) => site.exempt)).toEqual([true, false])
  })

  it('notes a computed resource instead of recording a tuple', () => {
    const found = collect(
      'fixture.ts',
      `const resource = itemTypeToResource(item.itemType)
await requirePermission(request, resource, 'update')`,
    )

    expect(found.sites).toEqual([])
    expect(found.computed).toHaveLength(1)
    expect(found.computed[0]?.snippet).toContain('resource')
  })

  it('notes a computed tool spec too', () => {
    const found = collect(
      'fixture.ts',
      `const spec = { resource: getResourceType(input.itemType), action: 'create' }`,
    )

    expect(found.sites).toEqual([])
    expect(found.computed).toHaveLength(1)
  })

  it('leaves an object that merely has both field names alone', () => {
    // `resource` and `action` are ordinary words. Only a pair that reads as
    // RBAC is a permission spec.
    expect(
      tuplesIn(`const row = { resource: 'invoice', action: 'emailed' }`),
    ).toEqual([])
  })
})
