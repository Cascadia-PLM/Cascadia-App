// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The comparison behind the push-time index-predicate repair.
 *
 * This one is tested because being wrong here *drops indexes*. A comparison
 * that stopped matching would quietly stop repairing — the failure this module
 * exists to fix, back again — and a comparison that inverted would drop every
 * partial index in the database and rebuild them, which is only survivable
 * because push rebuilds them. Neither shows up in the output of a healthy run.
 *
 * The cases are synthetic on purpose: a case naming a real index would break
 * the day that index is renamed, for reasons unrelated to what is tested here.
 *
 * Run: npx vitest run scripts/reconcile-index-predicates.test.ts
 */

import { describe, expect, it } from 'vitest'
import { predicateDrift } from './reconcile-index-predicates.mjs'

type Declared = Map<string, { table: string; partial: boolean }>
type Live = Array<{ indexname: string; indexdef: string }>

const drift = (declared: Declared, live: Live) => predicateDrift(declared, live)

const declare = (...entries: Array<[string, boolean]>): Declared =>
  new Map(
    entries.map(([name, partial]) => [name, { table: 'widgets', partial }]),
  )

const full = (name: string) => ({
  indexname: name,
  indexdef: `CREATE UNIQUE INDEX ${name} ON public.widgets USING btree (code)`,
})

const partial = (name: string, predicate = 'retired_at IS NULL') => ({
  indexname: name,
  indexdef: `CREATE UNIQUE INDEX ${name} ON public.widgets USING btree (code) WHERE (${predicate})`,
})

describe('predicateDrift', () => {
  it('reports an index the schema made partial and the database left full', () => {
    // The case that started this: a predicate added to an index that already
    // existed, which `drizzle-kit push` applies to nothing.
    expect(
      drift(declare(['widgets_code_idx', true]), [full('widgets_code_idx')]),
    ).toEqual([
      {
        name: 'widgets_code_idx',
        table: 'widgets',
        expected: 'partial',
        actual: 'full',
      },
    ])
  })

  it('reports the reverse, a predicate removed from the schema', () => {
    expect(
      drift(declare(['widgets_code_idx', false]), [
        partial('widgets_code_idx'),
      ]),
    ).toEqual([
      {
        name: 'widgets_code_idx',
        table: 'widgets',
        expected: 'full',
        actual: 'partial',
      },
    ])
  })

  it('accepts a database that agrees, partial or full', () => {
    expect(
      drift(declare(['a_idx', true], ['b_idx', false]), [
        partial('a_idx'),
        full('b_idx'),
      ]),
    ).toEqual([])
  })

  it('compares presence, not the text Postgres stores', () => {
    // Postgres rewrites what it is given — `status = 'In Progress'` comes back
    // as `((status)::text = 'In Progress'::text)`. Reading that as drift would
    // drop a correct index on every push.
    expect(
      drift(declare(['a_idx', true]), [
        partial('a_idx', "(status)::text = 'In Progress'::text"),
      ]),
    ).toEqual([])
  })

  it('ignores an index the snapshot does not declare', () => {
    // Hand-made indexes and leftovers from an older schema are not this
    // module's to drop.
    expect(
      drift(declare(['a_idx', true]), [partial('a_idx'), full('legacy_idx')]),
    ).toEqual([])
  })

  it('does not treat a missing index as drift', () => {
    // Push creates it, predicate and all. Only an index that already exists can
    // have the wrong one.
    expect(drift(declare(['a_idx', true]), [])).toEqual([])
  })
})
