// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * A query that pages must sort on a total order.
 *
 * `LIMIT`/`OFFSET` is only coherent when the sort distinguishes every row.
 * Postgres may return tied rows in a different sequence per query, so a page
 * boundary falling inside a run of ties silently repeats some rows and skips
 * others — no error, wrong data, on the grid people use to find parts.
 * `created_at` is the worst primary key for it because it is the transaction
 * timestamp: every row written by one seed, bulk import or ECO merge shares it
 * exactly.
 *
 * This rule exists because a comment demonstrably was not enough memory. The
 * lesson was learned and lost three times, and twice the fixed and unfixed
 * halves sat in the same file:
 *
 *   - `CommitService` and `DesignService` were each fixed in their own
 *     incident, both with a comment naming the overlap.
 *   - `ItemSearchService.buildGlobalOrderByClause` appends a tiebreaker under
 *     the comment "Secondary key keeps paging stable when the primary has
 *     ties"; `buildOrderByClause`, 260 lines below in that same file, did not.
 *   - `DesignService.buildOrderByClause` did not either — 200 lines below the
 *     paged query whose comment explains the exact hazard. Nothing found that
 *     one; it turned up while this rule was being written, which is the
 *     argument for the rule.
 *
 * ## What it checks
 *
 * A Drizzle chain containing `.offset(...)` must also call `.orderBy(...)`,
 * and that call must name an `id` column — either directly (`desc(items.id)`)
 * or through `paginatedOrderBy(primary, table.id)`, which is the preferred
 * form because it makes the tiebreaker a required argument.
 *
 * Direction is deliberately not checked. `asc(id)` and `desc(id)` are equally
 * total; `CommitService` uses `desc` to match its primary sort and is correct.
 *
 * ## Resolution, and what it cannot check
 *
 * The two sites that hid a defect were both `.orderBy(...orderBy)` — an array
 * built by a sibling method and spread in — so refusing to look through that
 * would miss exactly the shape this rule is for, while reporting every one of
 * them would make the rule noise and get it turned off. So it follows the
 * spread one hop, the same depth and for the same reason as
 * `no-indirect-effect-fetch`: an identifier resolves to its initializer, and a
 * call to a same-file method resolves to that method's body.
 *
 * One hop only. A builder that delegates to a second builder reads as
 * unverified and is reported; the fix is to name `paginatedOrderBy` in the
 * method that actually returns the array, which is where the tiebreaker
 * belongs anyway. Cross-file indirection is the honest remaining gap.
 */

/** The helper whose second argument is the tiebreaker. */
const HELPER = 'paginatedOrderBy'

const calleeName = (node) => {
  if (!node || node.type !== 'CallExpression') return null
  const callee = node.callee
  if (callee.type === 'Identifier') return callee.name
  if (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier'
  )
    return callee.property.name
  return null
}

/** Walk down a member chain collecting every `.method(...)` call in it. */
function chainCalls(node) {
  const calls = []
  let current = node
  while (current && current.type === 'CallExpression') {
    const name = calleeName(current)
    if (name) calls.push({ name, node: current })
    current =
      current.callee.type === 'MemberExpression' ? current.callee.object : null
  }
  return calls
}

/**
 * Every `return` in a function body, excluding those belonging to functions
 * nested inside it — a callback's return is not the builder's result.
 */
function collectReturns(fn) {
  const returns = []
  const visit = (n, depth) => {
    if (!n || typeof n.type !== 'string') return
    const isFunction =
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression' ||
      n.type === 'FunctionDeclaration'
    if (isFunction && depth > 0) return
    if (n.type === 'ReturnStatement') returns.push(n)
    for (const key of Object.keys(n)) {
      if (key === 'parent') continue
      const value = n[key]
      const next = isFunction ? depth + 1 : depth
      if (Array.isArray(value)) value.forEach((c) => visit(c, next))
      else if (value && typeof value.type === 'string') visit(value, next)
    }
  }
  visit(fn, 0)
  return returns
}

/** Does this subtree name an `id` column, or call the helper? */
function namesIdOrHelper(node) {
  let found = false
  const visit = (n) => {
    if (!n || typeof n.type !== 'string' || found) return
    if (
      n.type === 'MemberExpression' &&
      n.property.type === 'Identifier' &&
      n.property.name === 'id'
    ) {
      found = true
      return
    }
    if (n.type === 'CallExpression' && calleeName(n) === HELPER) {
      found = true
      return
    }
    for (const key of Object.keys(n)) {
      if (key === 'parent') continue
      const value = n[key]
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value.type === 'string') visit(value)
    }
  }
  visit(node)
  return found
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A query using .offset() must sort on a total order (an id column, ideally via paginatedOrderBy)',
    },
    schema: [],
    messages: {
      noOrderBy:
        'This query pages with .offset() but declares no .orderBy(). Paging without a total order repeats and skips rows silently. Use .orderBy(...paginatedOrderBy(primary, table.id)).',
      notTotal:
        'This query pages with .offset() but its .orderBy() names no id column, so tied rows may order differently per query and pages will repeat and skip rows silently. Use .orderBy(...paginatedOrderBy(primary, table.id)).',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    /** A same-file method or function declaration by name. */
    function findCallee(name) {
      let found = null
      const visit = (n) => {
        if (!n || typeof n.type !== 'string' || found) return
        if (
          (n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') &&
          n.key.type === 'Identifier' &&
          n.key.name === name
        ) {
          found = n
          return
        }
        if (n.type === 'FunctionDeclaration' && n.id && n.id.name === name) {
          found = n
          return
        }
        for (const key of Object.keys(n)) {
          if (key === 'parent') continue
          const value = n[key]
          if (Array.isArray(value)) value.forEach(visit)
          else if (value && typeof value.type === 'string') visit(value)
        }
      }
      visit(sourceCode.ast)
      return found
    }

    /** Follow a spread argument one hop: identifier → initializer → method body. */
    function resolvesToTotalOrder(argument) {
      if (namesIdOrHelper(argument)) return true
      if (argument.type !== 'SpreadElement') return false

      const spread = argument.argument
      if (spread.type !== 'Identifier') return false

      const variable = sourceCode
        .getScope(spread)
        .references.find((r) => r.identifier === spread)?.resolved
      const init = variable?.defs?.[0]?.node?.init
      if (!init) return false
      if (namesIdOrHelper(init)) return true

      // `const orderBy = this.buildOrderByClause(criteria)` — look inside the
      // builder, which is where the tiebreaker belongs.
      const builderName = calleeName(init)
      if (!builderName) return false
      const builder = findCallee(builderName)
      if (!builder) return false

      // EVERY return path, not "the method mentions the helper somewhere".
      // Asking the looser question makes the rule blind to its own subject:
      // `DesignService.buildOrderByClause` had one branch using the helper and
      // a fallback that did not, and a mention-anywhere check passes that —
      // which is exactly the one-fixed-one-unfixed twin the rule is for.
      // Verified by reintroducing that defect and watching this fail.
      const returns = collectReturns(builder)
      return (
        returns.length > 0 &&
        returns.every((r) => r.argument && namesIdOrHelper(r.argument))
      )
    }

    return {
      CallExpression(node) {
        if (calleeName(node) !== 'offset') return

        // Only the outermost `.offset(...)` in a chain reports, so one query
        // yields one error rather than one per enclosing call.
        const parent = node.parent
        if (
          parent &&
          parent.type === 'MemberExpression' &&
          parent.object === node &&
          parent.parent &&
          parent.parent.type === 'CallExpression'
        )
          return

        const calls = chainCalls(node)
        const orderBy = calls.find((c) => c.name === 'orderBy')

        if (!orderBy) {
          context.report({ node, messageId: 'noOrderBy' })
          return
        }
        if (!orderBy.node.arguments.some(resolvesToTotalOrder))
          context.report({ node: orderBy.node, messageId: 'notTotal' })
      },
    }
  },
}
