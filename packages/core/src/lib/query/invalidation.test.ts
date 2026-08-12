// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { RESOURCES, qk } from './keys'
import { expandResources } from './invalidation'
import type { Resource } from './keys'

/**
 * The dependency graph is what makes one `invalidate('parts')` refresh every
 * other view of that part. A missing edge does not fail loudly — it silently
 * reinstates the stale-data bug this layer exists to fix — so the invariants
 * are asserted here rather than left to reviewers to spot.
 */
describe('expandResources', () => {
  it('always includes the resources it was given', () => {
    for (const resource of RESOURCES) {
      expect(expandResources([resource])).toContain(resource)
    }
  })

  it('terminates on cyclic edges', () => {
    // parts -> items -> ... and physical-parts <-> work-orders are genuine
    // cycles; the traversal must not diverge on any starting point.
    for (const resource of RESOURCES) {
      const expanded = expandResources([resource])
      expect(expanded.length).toBeLessThanOrEqual(RESOURCES.length)
      expect(new Set(expanded).size).toBe(expanded.length)
    }
  })

  it('returns only known resources', () => {
    const known = new Set<string>(RESOURCES)
    for (const resource of RESOURCES) {
      for (const target of expandResources([resource])) {
        expect(known.has(target)).toBe(true)
      }
    }
  })

  it('routes every item-typed resource to the items aggregate', () => {
    // Each of these is also a row in `items`, so a write must refresh the
    // cross-item lists and the dashboard rollups that read it.
    const itemTyped: Array<Resource> = [
      'parts',
      'documents',
      'requirements',
      'tasks',
      'issues',
      'tools',
      'software',
      'test-cases',
      'test-plans',
      'work-instructions',
      'work-orders',
      'physical-parts',
      'change-orders',
    ]

    for (const resource of itemTyped) {
      const expanded = expandResources([resource])
      expect(expanded).toContain('items')
      expect(expanded).toContain('dashboard')
      expect(expanded).toContain('enterprise-search')
    }
  })

  it('reaches designs when a program changes, and vice versa', () => {
    // The program page lists its designs and the designs list joins program
    // names, so the two must refresh together — this is the exact pairing
    // behind "added a Design from the Program form and had to refresh".
    expect(expandResources(['designs'])).toContain('programs')
    expect(expandResources(['programs'])).toContain('designs')
  })

  it('fans a released change order out across the versioning surface', () => {
    // Releasing an ECO merges its branch and assigns revision letters, so
    // every versioned read changes at once.
    const expanded = expandResources(['change-orders'])
    for (const target of ['items', 'branches', 'commits', 'designs']) {
      expect(expanded).toContain(target)
    }
  })

  it('is order-independent and deduplicates across inputs', () => {
    const a = expandResources(['parts', 'designs'])
    const b = expandResources(['designs', 'parts'])
    expect(new Set(a)).toEqual(new Set(b))
    expect(new Set(a).size).toBe(a.length)
  })

  it('expands nothing for an empty input', () => {
    expect(expandResources([])).toEqual([])
  })
})

describe('qk', () => {
  it('nests list, detail and sub keys under the resource', () => {
    // Prefix containment is what lets `invalidateQueries(['designs'])` reach
    // a grid variant and a detail page that are not currently mounted.
    const all = qk.all('designs')
    const candidates = [
      qk.list('designs', { programId: 'p1' }),
      qk.detail('designs', 'd1'),
      qk.sub('designs', 'd1', 'branches'),
      qk.collection('designs', 'families'),
    ]

    for (const key of candidates) {
      expect(key.slice(0, all.length)).toEqual([...all])
    }
  })

  it('gives equal params the same key so loader and grid share one entry', () => {
    // Built separately by a route loader and by useServerDataGrid; TanStack
    // Query hashes structurally, so these must be value-equal.
    expect(qk.list('items', { itemType: 'Part', page: 1 })).toEqual(
      qk.list('items', { itemType: 'Part', page: 1 }),
    )
  })

  it('separates distinct entities and sub-collections', () => {
    expect(qk.detail('parts', 'a')).not.toEqual(qk.detail('parts', 'b'))
    expect(qk.sub('parts', 'a', 'files')).not.toEqual(
      qk.sub('parts', 'a', 'aml'),
    )
  })
})
