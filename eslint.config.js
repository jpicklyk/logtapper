import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid/configs/typescript';

export default tseslint.config(
  // ── Global ignores ──────────────────────────────────────────────────
  { ignores: ['dist-solid/', 'src-tauri/', 'node_modules/', 'mcp-server/'] },

  // ── Block 1: src-solid/ — the frontend ────────────────────────────
  // The Solid app reaches shared, framework-free code only through the aliases
  // in `solid.aliases.ts`, which all point into `src-shared/`.
  {
    files: ['src-solid/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      solid,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Warn for the spike — tightened to error once the viewer lands.
      'solid/reactivity': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-restricted-imports': ['error', {
        patterns: [
          // Barrel-only modules: these directories replaced the per-file
          // allow-list regexes that used to guard the reach into React
          // territory. The barrel IS the public API now — see principle 9 in
          // CLAUDE.md and `src-shared/CLAUDE.md`.
          //
          // `@bridge`, `@viewport`, `@cache`, `@filter` and `@bench` keep
          // file-level reach on purpose: `@bridge/types` is the IPC type
          // surface (~100 importers) and `@bridge/commands` / `@bridge/events`
          // / `@viewport/copyText` are partial-mocked by specifier in tests, a
          // re-exporting barrel would break those mocks.
          {
            regex: '^@(workspace|pipeline|fileinfo|processors|analysis|timeline|viewer|bookmarks)/',
            message: "Import the module barrel (e.g. `from '@workspace'`), not a file inside it — the barrel is the module's public API.",
          },
          {
            group: ['@tauri-apps/api/core'],
            importNames: ['invoke', 'Channel'],
            message: 'Use @bridge/commands wrappers instead of direct invoke()/Channel.',
          },
          {
            group: ['@tauri-apps/api/event'],
            importNames: ['listen'],
            message: 'Use @bridge/events wrappers instead of direct listen().',
          },
        ],
      }],
    },
  },

  // ── Block 2: src-shared/ — framework-free modules ──────────────────
  // Everything here is imported by src-solid/ through an alias and must stay
  // free of any UI framework: no React (the tree that once shared it is gone)
  // and no Solid either, so a future second consumer stays possible.
  {
    files: ['src-shared/**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // Overlaps with tsconfig's noUnusedLocals.
      '@typescript-eslint/no-unused-vars': 'off',

      // Convention 1: no direct 'Bugreport'/'Dumpstate' comparisons (use
      // isBugreportLike from bridge/types) and no JSON.stringify equality.
      'no-restricted-syntax': ['error',
        {
          selector: "BinaryExpression[operator='==='] > Literal[value='Bugreport']",
          message: "Do not compare directly against 'Bugreport'. Use isBugreportLike() from bridge/types instead.",
        },
        {
          selector: "BinaryExpression[operator='!=='] > Literal[value='Bugreport']",
          message: "Do not compare directly against 'Bugreport'. Use isBugreportLike() from bridge/types instead.",
        },
        {
          selector: "BinaryExpression[operator='==='] > Literal[value='Dumpstate']",
          message: "Do not compare directly against 'Dumpstate'. Use isBugreportLike() from bridge/types instead.",
        },
        {
          selector: "BinaryExpression[operator='!=='] > Literal[value='Dumpstate']",
          message: "Do not compare directly against 'Dumpstate'. Use isBugreportLike() from bridge/types instead.",
        },
        {
          selector: "BinaryExpression[operator='==='] > CallExpression > MemberExpression[object.name='JSON'][property.name='stringify']",
          message: 'Do not use JSON.stringify() for equality comparisons — use structural comparison on known fields instead.',
        },
        {
          selector: "BinaryExpression[operator='!=='] > CallExpression > MemberExpression[object.name='JSON'][property.name='stringify']",
          message: 'Do not use JSON.stringify() for equality comparisons — use structural comparison on known fields instead.',
        },
      ],

      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['react', 'react-*', 'react/*', 'react-dom/*', 'solid-js', 'solid-js/*'],
            message: 'src-shared/ is framework-free — a UI framework import here breaks the one rule this directory exists for.',
          },
          {
            group: ['**/src-solid/**'],
            message: 'src-shared/ is imported BY the frontend; it never imports one.',
          },
          {
            group: ['@tauri-apps/api/core'],
            importNames: ['invoke', 'Channel'],
            message: 'Use bridge/commands wrappers instead of direct invoke()/Channel.',
          },
          {
            group: ['@tauri-apps/api/event'],
            importNames: ['listen'],
            message: 'Use bridge/events wrappers instead of direct listen().',
          },
        ],
      }],
    },
  },

  // bridge/types.ts — defines isBugreportLike, needs the literal strings
  {
    files: ['src-shared/bridge/types.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // bridge/commands.ts — the authorized invoke()/Channel caller
  // bridge/events.ts — the authorized listen() caller
  {
    files: ['src-shared/bridge/commands.ts', 'src-shared/bridge/events.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

);
