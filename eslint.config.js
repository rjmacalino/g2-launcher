// Flat config (ESLint 9+). Type-aware rules would need a project reference
// for every file including this one and vite.config.ts, which is more setup
// than this project's size justifies; the syntax-only rule set below still
// catches the mistakes that actually happen here (unused code beyond what
// tsc's noUnusedLocals already blocks, accidental console.log left in,
// == instead of ===).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'g2-launcher.ehpk'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.browser },
    rules: {
      // tsc's noUnusedLocals/noUnusedParameters already cover this and
      // understand TypeScript better than the base rule does (it does not
      // flag a type-only import used only in a type position, for one).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      eqeqeq: 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The CLI helper script: runs under Node directly (npm run qr), not in
    // the WebView, so it gets Node globals and none of the browser ones.
    // console.log is its actual output, not a stray debug statement, so the
    // no-console rule that guards status() elsewhere does not apply here.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  prettier,
)
