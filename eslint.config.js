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
    files: ['scripts/**', 'test/**'],
    rules: { 'no-console': 'off' },
  },
);
