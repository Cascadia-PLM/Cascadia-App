// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'
import tseslint from 'typescript-eslint'
import { PROPRIETARY } from './scripts/edition-manifest.mjs'

/**
 * Import patterns that would put proprietary code inside core.
 *
 * Derived from the edition manifest's package names rather than written out
 * here, so the two cannot drift.
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

// Each module keeps its lib code under `lib/<module-name>/` and (where it
// has any) its components under `components/<module-name>/`, so those
// namespaces are patternable per package name. That convention is the whole
// coverage: a module file OUTSIDE its namesake namespace — cad-generation's
// components/{admin,parts}, advanced-auditing's server/routes/files-sign —
// is invisible to this rule and belongs to `boundary:check` (which resolves
// real paths) and its alias-collision pass.
//
// (A previous derivation filtered PROPRIETARY entries by 'packages/<p>/src/'
// prefixes — which no manifest entry has ever contained, the entries being
// 'packages/<p>/**' — so it provably contributed nothing and only the
// @cascadia/* patterns were live.)
const proprietaryImportPatterns = [
  ...MODULE_PACKAGES.flatMap((p) => [`@cascadia/${p}`, `@cascadia/${p}/**`]),
  ...MODULE_PACKAGES.flatMap((p) => [
    `@/lib/${p}`,
    `@/lib/${p}/**`,
    `**/lib/${p}/**`,
    `@/components/${p}/**`,
  ]),
]

// A search box is a contains-box, not a pattern language. Interpolating a
// user's term straight into a LIKE/ILIKE argument makes `%` and `_` wildcards:
// `A_1` matches `AB1`, and a bare `%` matches every row — a full table scan the
// user never asked for, and results that quietly disagree with the in-memory
// `String.includes` path. Build the pattern with likeContains / likeStartsWith
// / likeEndsWith from `@/lib/db/like-pattern`, which escape the term.
//
// Both selectors are argument-position only, and the `expressions.length > 0`
// guard keeps constant patterns such as `like(items.revision, '-%')` legal —
// those are the code's own patterns, not a user's text.
//
// Two known blind spots, documented rather than chased: a pattern variable
// built from a template literal elsewhere in the function, and raw
// sql`... ILIKE ...` (VersionResolver.itemFilterConditions, which pairs its own
// escaping with an explicit ESCAPE clause). After the sweep that landed with
// this rule no unescaped shape of either kind remains.
const likePatternRestrictions = [
  {
    selector:
      'CallExpression[callee.name=/^(like|ilike|notLike|notIlike)$/] > TemplateLiteral[expressions.length>0]',
    message:
      'Do not interpolate a term into a LIKE/ILIKE pattern — `%` and `_` become wildcards. Use likeContains/likeStartsWith/likeEndsWith from @/lib/db/like-pattern.',
  },
  {
    selector:
      "CallExpression[callee.name=/^(like|ilike|notLike|notIlike)$/] > BinaryExpression[operator='+']",
    message:
      'Do not concatenate a term into a LIKE/ILIKE pattern — `%` and `_` become wildcards. Use likeContains/likeStartsWith/likeEndsWith from @/lib/db/like-pattern.',
  },
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
      // Generated from the OpenAPI snapshot (npm run types:openapi) and
      // committed; nothing to review here either.
      'packages/core/src/lib/api/openapi-types.gen.ts',
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
  // `no-restricted-imports` matches the specifier *as written*: it sees the
  // `@cascadia/<pkg>/**` root-pinned form and the `@/lib/<pkg>/**` /
  // `@/components/<pkg>/**` namespace forms (each module keeps its code under
  // its namesake directories), but NOT a relative `./...` import, a dynamic
  // `import()`, a bare package id in a string, or a module file living outside
  // its namesake namespace (e.g. a contributed server route).
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
  // Data fetching goes through the query layer — never fetch inside an
  // effect. An effect-fetch bypasses the one shared TanStack Query cache:
  // the route loader cannot prime it, useInvalidateResources cannot reach
  // it, and every mount refetches. It is the load-bearing member of the five
  // replaced idioms catalogued in docs/development/data-fetching.md.
  //
  // The esquery descendant selector reaches fetches nested inside inner
  // async functions declared in the effect — the dominant shape. Known
  // limitation, documented rather than chased: a fetch inside a useCallback
  // that an effect merely *invokes* is not matched; the conversion batches
  // (FE-3..FE-6) remove those along with everything below.
  {
    files: [
      'packages/*/src/components/**/*.tsx',
      'packages/*/src/routes/**/*.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='useEffect'] CallExpression[callee.name=/^(fetch|apiFetch)$/]",
          message:
            'Fetch through the query layer (route loader + query factory + useInvalidateResources), not inside useEffect — see docs/development/data-fetching.md.',
        },
      ],
    },
  },
  // Allowlist for the rule above. It began as the effect-fetches that
  // predated the rule, pinned file by file while the conversion batches
  // (FE-3..FE-6) drained them; as of 2026-08-28 what remains are the two that
  // are deliberately NOT query reads. Files may only ever be REMOVED from
  // this list — never added.
  //
  //  - vault/FilePreview.tsx streams a file's bytes and hands back an object
  //    URL it must revoke on unmount. Putting that in the query cache would
  //    leak URLs nobody revokes; the effect owns the resource lifetime.
  //  - design-engine's CollaborativeWorkspace drives an SSE session whose
  //    effects are entangled with stream and session lifecycle; a mechanical
  //    swap would change semantics rather than preserve them.
  {
    files: [
      'packages/core/src/components/vault/FilePreview.tsx',
      'packages/design-engine/src/components/design-engine/CollaborativeWorkspace.tsx',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  // E2E journeys assert; they do not check whether the thing they came to
  // test happens to be on screen. `if (await x.isVisible())` around an
  // action or an assertion turns a broken page into a passing test — the
  // suite reported green while whole journeys did nothing. Use
  // `expect(...).toBeVisible()`, or an awaited click (Playwright waits for
  // actionability and fails loudly), the way the physical-traceability and
  // eco-workflow journeys do.
  //
  // Two shapes are banned: the `if` guard, and the
  // `.isVisible().catch(() => false)` idiom that spells the same thing as an
  // expression. A page object that genuinely must report "absent" — one
  // remains, DesignsPage.switchToECOBranch — expresses it as a bounded
  // waitFor whose result the caller consumes, not as a skipped assertion.
  {
    files: ['tests/e2e/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "IfStatement AwaitExpression CallExpression[callee.property.name='isVisible']",
          message:
            'Do not gate E2E steps on isVisible() — a missing element must fail the test, not skip it. Use expect(...).toBeVisible() or an awaited click.',
        },
        {
          selector:
            "CallExpression[callee.property.name='catch'][callee.object.callee.property.name='isVisible']",
          message:
            'Do not swallow isVisible() with .catch() — a missing element must fail the test. Use expect(...).toBeVisible() or an awaited click.',
        },
      ],
    },
  },
  // Escape user text before it reaches a LIKE/ILIKE pattern — see
  // `likePatternRestrictions` above for what and why.
  //
  // Scoped to `.ts` deliberately. `no-restricted-syntax` options OVERRIDE per
  // matched file rather than merge, so a broader glob here would silently
  // disable the effect-fetch ban — which is `.tsx`-only — and the E2E
  // isVisible ban, which lives outside `packages/`. The one `.ts` block that
  // does overlap is the routes/api one below; it spreads these selectors back
  // in so the override is neutral rather than merely improbable.
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...likePatternRestrictions],
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
        // Re-stated because this block overrides the LIKE-pattern block above
        // for any file it matches. `--max-warnings 0` makes 'warn' fatal in
        // CI just as 'error' is.
        ...likePatternRestrictions,
      ],
    },
  },
]
