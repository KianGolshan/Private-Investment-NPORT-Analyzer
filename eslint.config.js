const js = require('@eslint/js');
const globals = require('globals');
const eslintConfigPrettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['node_modules/**', 'public/index.html', 'cache.db*'],
  },
  js.configs.recommended,
  eslintConfigPrettier,
  {
    // server.js, cache.js, parsers.js, test/*.js — Node/CommonJS
    files: ['*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // Several call sites deliberately swallow a failure they can't act on
      // (e.g. an optional /api/config check at boot) — see cache.js/app.js.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // public/app.js — browser, plus the CDN-loaded globals it relies on
    // (Chart.js, SheetJS, jsPDF) that have no local import/require.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Chart: 'readonly',
        XLSX: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      // localStorage access (watchlist) intentionally degrades silently if
      // unavailable (e.g. private browsing) — see getWatchlist/saveWatchlist.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
