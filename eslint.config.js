// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'
import tseslint from 'typescript-eslint'
import { PROPRIETARY } from './scripts/edition-manifest.mjs'

/**
 * Import patterns that would put proprietary code inside core.
 *
 * Derived from the edition manifest rather than written out here, so the two
 * cannot drift. Directory entries become `**` groups; single files are matched
 * with and without their extension, since that is how they get imported.
 */
// Derived from the manifest, not listed. Writing the names here would put a
// proprietary package id inside a core file — `boundary:check` says so, and it
// is right: this file is published, where those packages do not exist. In the
// public tree `PROPRIETARY` is empty, so both lists below are empty and the
// rule below restricts nothing, which is exactly correct there.
const MODULE_PACKAGES = [
  ...new Set(
    PROPRIETARY.map((p) => /^packages\/([^/]+)\//.exec(p)?.[1]).filter(
      (name) => name !== undefined && name !== 'core',
    ),
  ),
]
const MODULE_SRC = MODULE_PACKAGES.map((p) => `packages/${p}/src/`)

const proprietaryImportPatterns = [
  ...MODULE_PACKAGES.flatMap((p) => [`@cascadia/${p}`, `@cascadia/${p}/**`]),
  ...PROPRIETARY.filter((p) => !p.endsWith('.md')).flatMap((p) => {
    const src = MODULE_SRC.find((s) => p.startsWith(s))
    if (!src) return []
    const path = p.endsWith('/**') ? p.slice(0, -3) : p.replace(/\.tsx?$/, '')
    const within = path.slice(src.length)
    const suffix = p.endsWith('/**') ? '/**' : ''
    return [`@/${within}${suffix}`, `**/${within}${suffix}`]
  }),
]

export default [
  {
    ignores: [
      '.output/**',
      '.nitro/**',
      '.claude/**',
      'dist/**',
      'node_modules/**',
      'html/**',
      'infra/**',
      '**/*.js',
      'packages/core/test-data/**',
      // Generated per app and gitignored. Type-aware linting two of these
      // alongside four TS programs exhausts the default heap, and there is
      // nothing to review in a file nobody writes.
      'apps/*/src/routeTree.gen.ts',
    ],
  },
  ...tanstackConfig,
  // Override rules that are too strict for this codebase
  {
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // Downgrade to warning - many false positives with defensive coding patterns
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      // Downgrade async-await requirement - useful for test setup functions
      '@typescript-eslint/require-await': 'warn',
    },
  },
  // The plain-ESM tooling: every script, and the publish pipeline.
  //
  // All 22 of these were matched by `'**/*.mjs'` in `ignores` — including
  // `publish/overlay.mjs`, the file that decides what reaches the public
  // repository. A duplicate `SUBSTITUTE` key there silently discarded a rule and
  // left `ARG APP=cascadia-enterprise` in both published Dockerfiles;
  // `no-dupe-keys` is a core rule and would have said so the moment it was
  // written. The most consequential file in the repository was the least
  // checked.
  //
  // Type-aware rules stay off. `checkJs` is unset, so the program carries no
  // real types for these files and the type-directed rules either crash for
  // want of parser services or invent findings from `any`. Nothing here needs
  // them: duplicate keys, unused variables and undefined references are all
  // syntactic.
  {
    files: ['scripts/**/*.mjs', 'publish/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // Core correctness rules, enabled explicitly rather than assumed. The
      // first one is the whole point: TypeScript rejects a duplicate object key
      // outright, so `.ts` never needed it, and `.mjs` with `checkJs` unset gets
      // neither that nor this. `no-dupe-keys` was measured silent here before
      // being added — a lint config that looks enabled and checks nothing is
      // worse than a visible gap.
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-unsafe-negation': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-compare': 'error',
      'use-isnan': 'error',
    },
  },
  // Core must not import proprietary code — the fast, in-editor half of the
  // boundary invariant, and deliberately only half.
  //
  // `no-restricted-imports` matches the specifier *as written*, so this sees
  // `@/lib/advanced-auditing/...` but NOT a relative `./advanced-auditing/...`,
  // a dynamic `import()`, or a bare package id in a string. Measured, not
  // assumed: the known-pending violations in `schema/index.ts` and
  // `server/index.ts` are relative imports and this rule stays silent on them.
  //
  // `npm run boundary:check` is the authority. It resolves every specifier to a
  // real path and classifies that, which is why it caught what two rounds of
  // grepping missed. This rule exists only so the common case surfaces as you
  // type rather than in CI. Do not treat a green lint as a clean boundary.
  //
  // Proprietary files and the composition roots are exempt — a module importing
  // its own package, and a root wiring modules in, are the point.
  //
  // Omitted entirely when there is nothing to restrict. ESLint rejects an empty
  // `group`, so a config that always declares the rule fails to *load* in the
  // published tree, where `PROPRIETARY` is empty by design — lint would not
  // report a violation there, it would refuse to run at all.
  ...(proprietaryImportPatterns.length > 0
    ? [
        {
          // Scoped to core by path, so no ignore list is needed: module files
          // simply are not in `packages/core`.
          files: ['packages/core/src/**/*.ts', 'packages/core/src/**/*.tsx'],
          rules: {
            'no-restricted-imports': [
              'error',
              {
                patterns: [
                  {
                    group: proprietaryImportPatterns,
                    message:
                      'Core cannot import proprietary code. Invert it through a registry — see docs/architecture/loadable-modules-architecture.md.',
                  },
                ],
              },
            ],
          },
        },
      ]
    : []),
  // Nudge API routes toward apiHandler/response builders instead of raw Response construction
  {
    files: ['packages/*/src/routes/api/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "NewExpression[callee.name='Response'][arguments.0.callee.object.name='JSON'][arguments.0.callee.property.name='stringify']",
          message:
            'Use apiHandler() with plain object returns, created(), or jsonResponse() instead of raw new Response(JSON.stringify(...)). See docs/api-improvements-guide.md.',
        },
      ],
    },
  },
]
