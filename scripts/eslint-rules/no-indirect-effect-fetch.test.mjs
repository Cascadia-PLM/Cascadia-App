// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `no-indirect-effect-fetch` — the reachability half of the effect-fetch ban.
 *
 * Gate 3 of the three-gate rule: the logic under test is scope resolution, not
 * a syntax match, and reading it is not enough to know what it does. What must
 * hold is a pair of invariants, and they pull against each other:
 *
 *   - a fetch an effect can REACH is reported, however the function is spelled;
 *   - a fetch nothing reaches is not, because `apiFetch` in an event handler or
 *     a `useResourceMutation` mutation function is the documented, correct way
 *     to write a mutation. A rule that reported those would be banning the
 *     pattern the codebase is supposed to use.
 *
 * The invalid cases below are the ratchet demonstrated red: each is a shape
 * that passed the `no-restricted-syntax` selector in eslint.config.js while
 * doing exactly what that selector exists to forbid.
 *
 * Run:
 *
 *   node scripts/eslint-rules/no-indirect-effect-fetch.test.mjs
 *
 * Deliberately runnable that way. Vitest's include globs are
 * `scripts/*.{test,spec}.ts` — top level, TypeScript — so this file is outside
 * the suite. `RuleTester` registers through global `describe`/`it` when they
 * exist and runs its cases inline when they do not, so the same file works
 * either way if the globs ever widen.
 */

import { RuleTester } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import rule from './no-indirect-effect-fetch.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    // The rule runs on .tsx. No `project`: it is a syntax-and-scope rule and
    // needs no type information, so the cases stay free of a tsconfig.
    parser: tsParser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
})

ruleTester.run('no-indirect-effect-fetch', rule, {
  valid: [
    // A handler nothing reaches from an effect. This is the mutation path the
    // codebase documents; banning it would ban the correct pattern.
    {
      code: `
function Component({ id, name }) {
  const handleSave = async () => {
    await apiFetch('/api/v1/parts/' + id, { method: 'PATCH', body: name })
  }
  useEffect(() => {
    setTitle(name)
  }, [name])
  return handleSave
}
`,
    },

    // A useResourceMutation mutation function — reached from the effect, and
    // still not a violation: the variable holds the mutation object, not the
    // function, so there is nothing for the rule to follow.
    {
      code: `
function Component({ id, autoArchive }) {
  const archive = useResourceMutation({
    mutationFn: () =>
      apiFetch('/api/v1/designs/' + id + '/archive', { method: 'POST' }),
    invalidates: ['designs'],
  })
  useEffect(() => {
    if (autoArchive) archive.mutate(id)
  }, [autoArchive, archive, id])
  return archive
}
`,
    },

    // Declared INSIDE the effect: the fetch is lexically within the useEffect
    // call, where the no-restricted-syntax selector already reports it. One
    // defect, one error.
    {
      code: `
function Component({ id }) {
  useEffect(() => {
    const load = async () => {
      await apiFetch('/api/v1/parts/' + id)
    }
    void load()
  }, [id])
}
`,
    },

    // Cross-file indirection — the documented limitation. `loadPart` resolves
    // to an import, and the rule does not follow modules.
    {
      code: `
import { loadPart } from './load-part'

function Component({ id }) {
  useEffect(() => {
    void loadPart(id)
  }, [id])
}
`,
    },

    // Shadowing. The `load` the effect calls is its own parameter, not the
    // fetching sibling of the same name.
    {
      code: `
function Component({ id }) {
  const load = async () => {
    await apiFetch('/api/v1/parts/' + id)
  }
  useEffect(() => {
    ((load) => load())(() => undefined)
  }, [id])
  return load
}
`,
    },

    // Re-assigned after its declaration. The name no longer stands for the
    // function written here, and scope analysis cannot say which one the
    // effect gets, so the rule declines rather than guesses. (Re-assignment
    // is a write REFERENCE, not a second definition — counting definitions
    // alone missed this, and this case is why the check counts writes.)
    {
      code: `
function Component({ id }) {
  let load = async () => {
    await apiFetch('/api/v1/parts/' + id)
  }
  load = async () => undefined
  useEffect(() => {
    void load()
  }, [id])
}
`,
    },

    // Depth 1 only: the effect calls `subscribe`, `subscribe` calls `load`.
    // Following the second hop is where false positives live.
    {
      code: `
function Component({ socket }) {
  const load = async () => {
    await apiFetch('/api/v1/things')
  }
  const subscribe = () => socket.on('change', load)
  useEffect(() => {
    subscribe()
  }, [subscribe])
}
`,
    },
  ],

  invalid: [
    // (a) The dominant shape: a sibling async function the effect body calls.
    // Reported at the fetch, not at the effect — line 4 is the `apiFetch`.
    {
      code: `
function Component({ id }) {
  const loadPart = async () => {
    const res = await apiFetch('/api/v1/parts/' + id)
    setPart(res)
  }
  useEffect(() => {
    void loadPart()
  }, [id])
}
`,
      errors: [
        {
          messageId: 'indirectEffectFetch',
          data: { name: 'loadPart' },
          type: 'CallExpression',
          line: 4,
        },
      ],
    },

    // (b) A useCallback named only in the dependency array. An effect that
    // re-runs when a callback's identity changes lists it there and never
    // writes the name in its body, so the deps are the only place to see it.
    {
      code: `
function Component({ onReady }) {
  const load = useCallback(async () => {
    await apiFetch('/api/v1/things')
  }, [])
  useEffect(() => {
    onReady()
  }, [load, onReady])
}
`,
      errors: [{ messageId: 'indirectEffectFetch', data: { name: 'load' } }],
    },

    // A hoisted `function` declaration, written after the effect that calls it.
    {
      code: `
function Component({ open }) {
  useEffect(() => {
    if (open) runAssessment()
  }, [open])

  async function runAssessment() {
    const response = await apiFetch('/api/v1/assessment')
    return response
  }
}
`,
      errors: [
        { messageId: 'indirectEffectFetch', data: { name: 'runAssessment' } },
      ],
    },

    // The bare form: the effect IS the function, passed by name.
    {
      code: `
function Component() {
  const loadAll = async () => {
    await fetch('/api/v1/designs')
  }
  useEffect(loadAll, [])
}
`,
      errors: [{ messageId: 'indirectEffectFetch', data: { name: 'loadAll' } }],
    },

    // Two fetches in one reached function are two defects; two effects
    // reaching the same function are still one report per fetch.
    {
      code: `
function Component({ id }) {
  const load = async () => {
    await apiFetch('/api/v1/parts/' + id)
    await apiFetch('/api/v1/parts/' + id + '/bom')
  }
  useEffect(() => {
    void load()
  }, [id])
  useEffect(() => {
    void load()
  }, [])
}
`,
      errors: [
        { messageId: 'indirectEffectFetch', data: { name: 'load' }, line: 4 },
        { messageId: 'indirectEffectFetch', data: { name: 'load' }, line: 5 },
      ],
    },
  ],
})

// RuleTester ran the cases inline (no test harness present), so reaching here
// means they all passed — say so, since nothing else would.
if (typeof describe !== 'function') {
  console.log('✅ no-indirect-effect-fetch: all RuleTester cases passed.')
}
