// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/node_modules/**',
    'apps/desktop/src-tauri/**',
    'e2e/test-results/**',
    'e2e/playwright-report/**',
    'packages/db/src/generated/**',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['vitest.shared.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      // React event handlers may be async; typescript-eslint's documented setting for JSX attributes.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      eqeqeq: ['error', 'smart'],
      'no-console': 'error',
    },
  },
  {
    // NestJS resolves constructor dependencies from emitted type metadata, so classes used as
    // injection tokens must stay value imports even when only used as types.
    files: ['apps/api/**/*.ts', 'apps/ingestor/**/*.ts', 'apps/analyzer/**/*.ts', 'apps/jobs/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
  {
    // Development scripts (fixture builders) report what they wrote.
    files: ['packages/*/scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: [
      'packages/app/**/*.{ts,tsx}',
      'packages/ui/**/*.{ts,tsx}',
      'apps/web/**/*.{ts,tsx}',
      'apps/desktop/**/*.{ts,tsx}',
    ],
    extends: [reactHooks.configs.flat['recommended-latest'] ?? reactHooks.configs.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts', 'e2e/**/*.ts', '**/*.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
