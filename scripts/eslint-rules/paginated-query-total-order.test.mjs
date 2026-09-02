// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `paginated-query-total-order` — the resolution half of the paging invariant.
 *
 * Gate 3 of the three-gate rule: what is under test is chain walking and
 * one-hop scope resolution, not a syntax match, and reading the rule is not
 * enough to know what it does. Two invariants pull against each other:
 *
 *   - a paged query whose sort cannot distinguish tied rows is reported,
 *     however the order is spelled and wherever it is built;
 *   - a query that is already total is not, because `desc(table.id)` written
 *     by hand is as total as the helper and `CommitService` uses exactly that.
 *     A rule that reported those would be noise, and a noisy rule gets turned
 *     off.
 *
 * The failure mode this file exists against is specific and quiet. Every case
 * below could regress into the rule reporting *nothing* — a broken scope
 * lookup, a chain walk that stops early, a resolution that throws and is
 * swallowed — and a rule that finds nothing is indistinguishable from a clean
 * codebase. Nothing else in CI would notice.
 *
 * The every-return-path cases are the ones that earned this file. An earlier
 * version of the rule asked whether the builder *mentioned* the helper
 * anywhere, which passes a builder with one fixed branch and one defective
 * one — precisely the one-fixed-one-unfixed twin the rule exists to catch, and
 * precisely the state `DesignService.buildOrderByClause` was in when the looser
 * version was pointed at it.
 *
 * Run:
 *
 *   node scripts/eslint-rules/paginated-query-total-order.test.mjs
 *
 * Runnable that way and under vitest both: `RuleTester` registers through
 * global `describe`/`it` when they exist and runs its cases inline when they
 * do not.
 */

import { RuleTester } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import rule from './paginated-query-total-order.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    // No `project`: this is a syntax-and-scope rule and needs no type
    // information, so the cases stay free of a tsconfig.
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
})

ruleTester.run('paginated-query-total-order', rule, {
  valid: [
    // The helper, inline. The shape every migrated call site uses.
    {
      code: `
const rows = await db
  .select()
  .from(items)
  .orderBy(...paginatedOrderBy(desc(items.createdAt), items.id))
  .limit(50)
  .offset(offset)
`,
    },

    // An id written by hand, descending. As total as the helper —
    // CommitService does this deliberately to match its primary sort, and
    // direction is not the rule's business.
    {
      code: `
const rows = await db
  .select()
  .from(commits)
  .orderBy(desc(commits.createdAt), desc(commits.id))
  .limit(limit)
  .offset(offset)
`,
    },

    // No paging at all: an unbounded ordered fetch needs no tiebreaker,
    // because there is no page boundary to fall inside a run of ties.
    {
      code: `
const rows = await db.select().from(jobs).orderBy(desc(jobs.createdAt))
`,
    },

    // One hop through a local variable whose initializer names the helper.
    {
      code: `
const orderBy = paginatedOrderBy(desc(programs.createdAt), programs.id)
const rows = await db
  .select()
  .from(programs)
  .orderBy(...orderBy)
  .limit(limit)
  .offset(offset)
`,
    },

    // One hop through a sibling method — the shape both real defects hid
    // behind. Every return path uses the helper, so it resolves clean.
    {
      code: `
class DesignService {
  static buildOrderByClause(criteria) {
    if (!criteria.sortField) {
      return paginatedOrderBy(desc(designs.createdAt), designs.id)
    }
    return paginatedOrderBy(direction(column), designs.id)
  }

  static async search(criteria) {
    const orderBy = this.buildOrderByClause(criteria)
    return db
      .select()
      .from(designs)
      .orderBy(...orderBy)
      .limit(50)
      .offset(criteria.offset)
  }
}
`,
    },

    // A builder returning a hand-written id term, through the same hop.
    {
      code: `
function buildOrder() {
  return [desc(commits.createdAt), desc(commits.id)]
}

const orderBy = buildOrder()
const rows = await db
  .select()
  .from(commits)
  .orderBy(...orderBy)
  .limit(10)
  .offset(0)
`,
    },
  ],

  invalid: [
    // The headline defect: ItemSearchService.buildOrderByClause returned this
    // for every per-type item list in the app.
    {
      code: `
const rows = await db
  .select()
  .from(items)
  .orderBy(desc(items.createdAt))
  .limit(50)
  .offset(offset)
`,
      errors: [{ messageId: 'notTotal' }],
    },

    // A non-unique column that reads like a key. `itemNumber` carries no
    // uniqueness constraint, which is why the by-number paging was wrong.
    {
      code: `
const rows = await db
  .select()
  .from(items)
  .orderBy(items.itemNumber)
  .limit(20)
  .offset(0)
`,
      errors: [{ messageId: 'notTotal' }],
    },

    // Paging with no ORDER BY at all — worse, and a different message.
    {
      code: `
const rows = await db.select().from(items).limit(50).offset(offset)
`,
      errors: [{ messageId: 'noOrderBy' }],
    },

    // EVERY return path, not "mentions the helper somewhere". This builder has
    // one correct branch and one defective one; the looser check passed it,
    // and that is the exact state DesignService.buildOrderByClause was in.
    {
      code: `
class DesignService {
  static buildOrderByClause(criteria) {
    if (!criteria.sortField) {
      return [desc(designs.createdAt)]
    }
    return paginatedOrderBy(direction(column), designs.id)
  }

  static async search(criteria) {
    const orderBy = this.buildOrderByClause(criteria)
    return db
      .select()
      .from(designs)
      .orderBy(...orderBy)
      .limit(50)
      .offset(criteria.offset)
  }
}
`,
      errors: [{ messageId: 'notTotal' }],
    },

    // The early-return half of the same shape, which is the branch my own fix
    // to that method missed until this rule was tightened.
    {
      code: `
class ItemSearchService {
  static buildOrderByClause(criteria) {
    if (!criteria.sortField) {
      return [desc(items.createdAt)]
    }
    if (baseColumns[criteria.sortField]) {
      return [direction(baseColumns[criteria.sortField])]
    }
    return [desc(items.createdAt)]
  }

  static async search(criteria) {
    const orderBy = this.buildOrderByClause(criteria)
    return db
      .select()
      .from(items)
      .orderBy(...orderBy)
      .limit(50)
      .offset(criteria.offset)
  }
}
`,
      errors: [{ messageId: 'notTotal' }],
    },

    // A builder that delegates to a second builder: one hop only, so this
    // reads as unverified and is reported. The documented limit, pinned so it
    // is a decision rather than a surprise — the fix is to name the helper in
    // the method that actually returns the array.
    {
      code: `
function inner() {
  return paginatedOrderBy(desc(items.createdAt), items.id)
}

function outer() {
  return inner()
}

const orderBy = outer()
const rows = await db
  .select()
  .from(items)
  .orderBy(...orderBy)
  .limit(50)
  .offset(0)
`,
      errors: [{ messageId: 'notTotal' }],
    },

    // One query, one error — the outermost .offset() reports and the enclosing
    // chain does not report it again.
    {
      code: `
const rows = await db
  .select()
  .from(items)
  .where(and(...conditions))
  .orderBy(desc(items.modifiedAt))
  .limit(limit)
  .offset(offset)
`,
      errors: 1,
    },
  ],
})

// RuleTester ran the cases inline (no test harness present), so reaching here
// means they all passed — say so, since nothing else would.
if (typeof describe !== 'function') {
  console.log('✅ paginated-query-total-order: all RuleTester cases passed.')
}
