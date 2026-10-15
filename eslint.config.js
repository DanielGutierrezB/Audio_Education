'use strict';

// Deliberately focused on things that are bugs, not on style. The codebase
// uses column alignment on purpose (settings maps, filter parameter tables)
// and carries the reasoning behind every audio decision in its comments, so a
// blanket reformat would cost more in blame and readability than it returns.

const js = require('@eslint/js');
const globals = require('globals');

const SHARED_RULES = {
  // The bugs this codebase can actually produce: a filter string built from a
  // variable that doesn't exist, a promise nobody waits on, a duplicated key
  // in one of the settings maps.
  'no-undef': 'error',
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
  }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'error',
  'no-promise-executor-return': 'error',
  'no-async-promise-executor': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'bin/**', 'build/icons/**', 'corpus/**'],
  },
  js.configs.recommended,
  {
    // Main process, shared modules and scripts: Node, CommonJS.
    files: ['main.js', 'preload.js', 'src/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: SHARED_RULES,
  },
  {
    // Renderer: browser globals, plus the `api` bridge preload.js exposes.
    files: ['renderer/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, api: 'readonly' },
    },
    rules: {
      ...SHARED_RULES,
      // The renderer is loaded as several plain <script> tags sharing one
      // scope, so helpers defined in one file are used from another.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // src/enhance/ is a hand-synced copy of adobe-podcast-batch's engine, kept
    // line-by-line close to upstream so a manual diff is enough when Adobe
    // changes something (docs/PLAN.md §5 D6). Tidying it here would be paid
    // for at every future sync.
    files: ['src/enhance/**/*.js'],
    rules: { 'no-promise-executor-return': 'off' },
  },
  {
    // Playwright specs run in Node, but the callbacks passed to page.evaluate
    // are serialised and executed in the renderer, so `window` is a legitimate
    // global inside them.
    files: ['test/smoke/**/*.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, window: 'readonly' },
    },
    rules: SHARED_RULES,
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: SHARED_RULES,
  },
];
