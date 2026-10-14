const js = require('@eslint/js');
const globals = require('globals');
const eslintConfigPrettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['node_modules/**', 'cache.db*', 'warehouse.db*', 'web/**'],
  },
  js.configs.recommended,
  eslintConfigPrettier,
  {
    // server.js, parsers.js, lib/, scripts/, test/, deploy/ — Node/CommonJS
    files: ['*.js', 'lib/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'deploy/**/*.js'],
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
      // (e.g. an optional /api/config check at boot).
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
