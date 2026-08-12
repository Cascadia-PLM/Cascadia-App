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
const ENTERPRISE_SRC = 'packages/enterprise/src/'

const proprietaryImportPatterns = [
  '@cascadia/enterprise',
  '@cascadia/enterprise/**',
  ...PROPRIETARY.filter(
    (p) => p.startsWith(ENTERPRISE_SRC) && !p.endsWith('.md'),
  ).flatMap((p) => {
    const path = p.endsWith('/**') ? p.slice(0, -3) : p.replace(/\.tsx?$/, '')
    const within = path.slice(ENTERPRISE_SRC.length)
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
      '**/*.mjs',
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
  {
    // Scoped to core by path now, so no ignore list is needed: module files
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
                'Core cannot import proprietary code. Invert it through a registry — see docs/proposals/loadable-modules-architecture.md.',
            },
          ],
        },
      ],
    },
  },
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
