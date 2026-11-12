import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      '.next/',
      'coverage/',
      'docs/',
      'playwright-report/',
      'test-results/',
      'next-env.d.ts',
    ],
  },
  js.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The proposal model boundary cannot reach anything that approves, schedules or executes refunds.
    files: ['src/ai/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/db/**',
                '**/queue/**',
                '**/worker/**',
                '**/paypal/**',
                '**/services/**',
                '**/http/**',
                'pg',
              ],
              message:
                'src/ai may not touch persistence, approvals, the outbox, the worker or the PayPal adapter.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**', 'test/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Test helpers parse arbitrary JSON response bodies.
    files: ['test/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
