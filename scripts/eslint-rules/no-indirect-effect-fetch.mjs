// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Ban the *indirect* effect-fetch: a `useEffect` that reaches the network by
 * calling a sibling function instead of calling `fetch` in its own body.
 *
 * The `no-restricted-syntax` selector in `eslint.config.js` is lexical — it
 * sees a `fetch`/`apiFetch` call written **inside** the `useEffect` callback,
 * and nothing else. So the same defect written as
 *
 *     const load = async () => { await apiFetch(...) }
 *     useEffect(() => { void load() }, [id])
 *
 * passed the gate while doing exactly what the gate exists to forbid: bypassing
 * the one shared TanStack Query cache, so the route loader cannot prime it,
 * `useInvalidateResources` cannot reach it, and every mount refetches. See
 * docs/development/data-fetching.md.
 *
 * What it does NOT ban, deliberately: `apiFetch` inside a `useCallback` or a
 * plain handler that no effect ever calls. That is the documented *mutation*
 * path — event handlers and `useResourceMutation` mutation functions — and
 * banning it would be banning the correct pattern. The reachability check is
 * the whole difference between the two.
 *
 * Resolution is deliberately shallow and same-file:
 *
 *   - Identifiers are collected from the `useEffect` callback **and** its
 *     dependency array. The dep array matters on its own: a `useCallback` an
 *     effect depends on is a function that effect calls, and the dep array is
 *     sometimes the only place the name is written out.
 *   - Each identifier is resolved through ESLint's scope analysis, so
 *     shadowing comes out right and an imported name resolves to an
 *     `ImportBinding` definition, which is skipped — cross-file indirection
 *     is the one honest gap left, and it is out of scope here.
 *   - Only depth 1 is followed: the function the effect names is scanned, not
 *     the functions *it* calls. Every instance this rule was written against
 *     had the shape effect → named function → fetch, and each further hop
 *     trades a real catch for false positives on helpers that merely happen to
 *     be reachable.
 *   - A function DEFINED inside the effect is skipped: its fetches are
 *     lexically inside the `useEffect` call, where the `no-restricted-syntax`
 *     selector already reports them. Skipping keeps one defect to one error.
 */

/** Callees that mean "this went to the network". Mirrors the lexical rule. */
const FETCH_CALLEES = new Set(['fetch', 'apiFetch'])

/**
 * Hooks whose first argument is the function the identifier stands for.
 * `useCallback(fn, deps)` is the only one an effect routinely calls; a
 * `useMemo` that returns a function is rare enough not to guess at.
 */
const FUNCTION_WRAPPER_HOOKS = new Set(['useCallback'])

/** Keys that are not child nodes. `parent` in particular would loop forever. */
const NON_CHILD_KEYS = new Set(['parent', 'loc', 'range', 'start', 'end'])

/** Depth-first walk over a node and everything nested inside it. */
function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (typeof value.type !== 'string') return

  visit(value)
  for (const key of Object.keys(value)) {
    if (NON_CHILD_KEYS.has(key)) continue
    walk(value[key], visit)
  }
}

function isFunctionNode(node) {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  )
}

/** Is `node` the same as, or nested inside, `ancestor`? */
function isWithin(node, ancestor) {
  let current = node
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

/**
 * The function a resolved variable stands for, or null if it is not one.
 *
 * A name that is declared twice, or assigned again after its declaration, may
 * not hold the function written here by the time the effect runs. Which one it
 * holds is not a question scope analysis answers, so the rule declines rather
 * than guesses — the `init` write of the declarator itself is not one of those
 * assignments.
 */
function functionOf(variable) {
  if (variable.defs.length !== 1) return null
  if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return null
  const def = variable.defs[0]

  // `function load() { … }`
  if (def.type === 'FunctionName') return def.node

  // `const load = …`
  if (def.type !== 'Variable') return null
  const init = def.node.init
  if (!init) return null
  if (isFunctionNode(init)) return init

  // `const load = useCallback(() => { … }, [deps])`
  if (
    init.type === 'CallExpression' &&
    init.callee.type === 'Identifier' &&
    FUNCTION_WRAPPER_HOOKS.has(init.callee.name)
  ) {
    const wrapped = init.arguments[0]
    if (wrapped && isFunctionNode(wrapped)) return wrapped
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reaching the network from a useEffect by way of a sibling function',
    },
    schema: [],
    messages: {
      indirectEffectFetch:
        'Fetch through the query layer (route loader + query factory + useInvalidateResources), not from `{{name}}`, which a useEffect calls — see docs/development/data-fetching.md.',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode
    /** Identifier node -> the variable it resolves to. Built on first use. */
    let resolutions = null
    /** Fetch call sites already reported, so one defect is one error. */
    const reported = new Set()

    /**
     * Index every resolved reference in the file.
     *
     * Going through the scope manager rather than matching names by hand is
     * what makes shadowing and imports come out right: a reference that
     * resolves to nothing (a global such as `fetch`) or to an import is simply
     * absent from what this rule will follow.
     */
    function referenceIndex() {
      if (resolutions) return resolutions
      resolutions = new Map()
      for (const scope of sourceCode.scopeManager.scopes) {
        for (const reference of scope.references) {
          if (reference.resolved) {
            resolutions.set(reference.identifier, reference.resolved)
          }
        }
      }
      return resolutions
    }

    return {
      "CallExpression[callee.name='useEffect']"(effect) {
        const index = referenceIndex()

        // The callback and the dependency array both name what the effect
        // calls; walking the whole argument list covers `useEffect(load, [])`
        // as well as the usual inline callback.
        const named = new Set()
        walk(effect.arguments, (node) => {
          if (node.type !== 'Identifier') return
          const variable = index.get(node)
          if (variable) named.add(variable)
        })

        for (const variable of named) {
          const fn = functionOf(variable)
          if (!fn) continue
          // Defined inside the effect: the lexical rule already reports it.
          if (isWithin(fn, effect)) continue

          walk(fn, (node) => {
            if (node.type !== 'CallExpression') return
            if (node.callee.type !== 'Identifier') return
            if (!FETCH_CALLEES.has(node.callee.name)) return
            if (reported.has(node)) return
            reported.add(node)
            context.report({
              node,
              messageId: 'indirectEffectFetch',
              data: { name: variable.name },
            })
          })
        }
      },
    }
  },
}

export default rule
