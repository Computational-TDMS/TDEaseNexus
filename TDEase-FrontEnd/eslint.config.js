import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import globals from 'globals'

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/strongly-recommended'],
  {
    // Renderer sources. `no-undef` is off for every TS-parsed file
    // (typescript-eslint's own recommendation): vue-tsc/tsc run in the build
    // chain and are the authority on undefined identifiers.
    files: ['src/**/*.ts'],
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      'no-console': 'off',
    },
  },
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        sourceType: 'module',
      },
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'warn',
      'vue/attributes-order': 'warn',
      'vue/block-tag-newline': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/html-self-closing': 'off',
      'vue/require-expose': 'off',
      'vue/require-default-prop': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Electron main process. Build scripts (.mjs) are not TS-checked, so
    // `no-undef` stays ON here and Node host globals are declared. Same
    // unused-vars policy as src (warn; `^_` marks intentional).
    files: ['electron/**/*.{ts,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Node-hosted E2E fixtures (standalone servers spawned by Playwright):
    // not TS-checked, so no-undef needs the Node globals declared.
    files: ['tests/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'vue/one-component-per-file': 'off',
      'vue/require-prop-types': 'off',
      // Test mounts use single-word stub components and set every prop
      // explicitly — component-facing defaults rules are meaningless there.
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
    },
  },
  {
    files: ['src/utils/error-taxonomy.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // STUDIO-FRONTEND-BUSINESS-LOGIC.md §"Import direction": `agent/` may
    // import `studio/commands` and `studio/domain`; `studio/` must never
    // import `agent/` — the Agent is a client of the business core, not a
    // peer. Enforced here so the boundary is structural, not a review
    // convention.
    files: ['src/studio/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/agent', '@/agent/*', '../../agent', '../../agent/*'],
          message: 'studio/ must never import agent/ (STUDIO-FRONTEND-BUSINESS-LOGIC.md): the Agent is a client of the business core, not a peer.',
        }],
      }],
    },
  },
  {
    // Source trees only: `pnpm run lint` targets `src electron` explicitly.
    // Everything below is output, vendored or runtime data — packaged app
    // (release/), build output (dist/), Playwright artifacts, the simulated
    // client install (data/) and static assets.
    ignores: [
      'dist/',
      'release/',
      'test-results/',
      'tmp/',
      'tmp-diag/',
      'data/',
      'public/',
      'node_modules/',
      'config/',
      'scripts/',
      'electron/dist/',
      '**/*.cjs',
    ],
  },
]
