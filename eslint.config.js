//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'
import tseslint from 'typescript-eslint'

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
      'test-data/**',
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
  // Nudge API routes toward apiHandler/response builders instead of raw Response construction
  {
    files: ['src/routes/api/**/*.ts'],
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
