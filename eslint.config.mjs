import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/test-results/**',
    'examples/blazor-wasm/bin/**',
    'examples/blazor-wasm/obj/**',
    'tools/package-boundary-fixtures/**',
    'tools/protocol-probe/**',
  ]),
  {
    files: ['**/*.{cjs,js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module',
    },
  },
  {
    files: ['examples/blazor-wasm/wwwroot/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'examples/vanilla-ts/src/**/*.ts',
      'examples/react/src/**/*.{ts,tsx}',
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.strict, tseslint.configs.stylistic],
  },
  {
    files: ['packages/*/src/**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { jsdoc },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { allowDefaultCaseForExhaustiveSwitch: false },
      ],
      'jsdoc/check-tag-names': ['error', { definedTags: ['internal'] }],
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            ClassDeclaration: true,
            FunctionDeclaration: true,
          },
        },
      ],
      'no-console': 'error',
      'no-warning-comments': [
        'error',
        { location: 'anywhere', terms: ['todo', 'fixme'] },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'Inject wall and monotonic clocks at package boundaries.',
        },
        {
          name: 'performance',
          message: 'Inject a monotonic clock at package boundaries.',
        },
        {
          name: 'setInterval',
          message: 'Use an explicit scheduler with lifecycle ownership.',
        },
        {
          name: 'setTimeout',
          message: 'Use an explicit scheduler with lifecycle ownership.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Inject deterministic identifiers or randomness.',
        },
      ],
    },
  },
);
