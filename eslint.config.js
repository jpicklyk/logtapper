import { createRequire } from 'module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

const require = createRequire(import.meta.url);
const localRules = require('./eslint-local-rules/index.cjs');

export default tseslint.config(
  // ── Global ignores ──────────────────────────────────────────────────
  { ignores: ['dist/', 'src-tauri/', 'node_modules/', 'src/', 'mcp-server/'] },

  // ── Block 1: All src-next/ files ────────────────────────────────────
  // Base rulesets + conventions 1 (no direct sourceType comparisons),
  // 4 (no direct invoke/Channel), 5 (no direct listen)
  {
    files: ['src-next/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'local-rules': localRules,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // ── Community standard rules ──────────────────────────────────
      // Only enable the two classic react-hooks rules. The v7 plugin added
      // Compiler-related rules (refs, set-state-in-effect, preserve-manual-memoization,
      // no-access-state-in-render) that flag intentional patterns in our React 18 codebase.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Disable rules that overlap with tsconfig strict checks
      '@typescript-eslint/no-unused-vars': 'off',

      // No side effects (IPC, localStorage, bus.emit, fetch) inside setState updaters
      'local-rules/no-side-effects-in-updater': 'error',

      // ── Convention 1: No direct 'Bugreport'/'Dumpstate' comparisons ─
      // Use isBugreportLike() from bridge/types instead
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
        // ── No JSON.stringify equality comparisons ───────────────────
        // JSON.stringify(a) === JSON.stringify(b) is O(n) serialization;
        // use structural comparison on known fields instead.
        {
          selector: "BinaryExpression[operator='==='] > CallExpression > MemberExpression[object.name='JSON'][property.name='stringify']",
          message: 'Do not use JSON.stringify() for equality comparisons — use structural comparison on known fields instead.',
        },
        {
          selector: "BinaryExpression[operator='!=='] > CallExpression > MemberExpression[object.name='JSON'][property.name='stringify']",
          message: 'Do not use JSON.stringify() for equality comparisons — use structural comparison on known fields instead.',
        },
      ],

      // ── Convention 4: No direct invoke()/Channel outside bridge ─────
      // ── Convention 5: No direct listen() outside bridge + 2 hooks ───
      // ── Convention 9: No deprecated useViewerActions ────────────────
      'no-restricted-imports': ['error', {
        patterns: [
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
          {
            group: ['**/context', '**/context/index*'],
            importNames: ['useViewerActions'],
            message: 'useViewerActions is deprecated. Use useNavigationActions, useFileActions, usePaneActions, or useSettingsActions instead.',
          },
        ],
      }],
    },
  },

  // ── Block 2: Components — additional restrictions ───────────────────
  // Convention 2 (no raw context hooks), Convention 3 (require-memo),
  // Convention 7 (barrel imports for cache)
  {
    files: ['src-next/components/**/*.tsx'],
    plugins: {
      'local-rules': localRules,
    },
    rules: {
      // Convention 3: Exported components must be wrapped in React.memo()
      'local-rules/require-memo': 'error',
      // No writes to module-level Maps/Sets/singletons during render.
      // Move .set()/.add() calls into useEffect to avoid concurrent-mode issues.
      'local-rules/no-map-write-in-render': 'error',
    },
  },
  {
    files: ['src-next/components/**/*.{ts,tsx}'],
    rules: {
      // Must repeat Block 1 patterns since no-restricted-imports doesn't merge
      'no-restricted-imports': ['error', {
        patterns: [
          // Convention 4 + 5 (repeated from Block 1)
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
          // Convention 9: No deprecated useViewerActions
          {
            group: ['**/context', '**/context/index*'],
            importNames: ['useViewerActions'],
            message: 'useViewerActions is deprecated. Use useNavigationActions, useFileActions, usePaneActions, or useSettingsActions instead.',
          },
          // Convention 2: No raw context hook imports in components
          {
            group: ['**/context/SessionContext*'],
            message: 'Use selector hooks from context barrel, not raw SessionContext.',
          },
          {
            group: ['**/context/ViewerContext*'],
            message: 'Use selector hooks from context barrel, not raw ViewerContext.',
          },
          {
            group: ['**/context/PipelineContext*'],
            message: 'Use selector hooks from context barrel, not raw PipelineContext.',
          },
          {
            group: ['**/context/TrackerContext*'],
            message: 'Use selector hooks from context barrel, not raw TrackerContext.',
          },
          {
            group: ['**/context/ActionsContext*'],
            message: 'Use selector hooks from context barrel, not raw ActionsContext.',
          },
          {
            group: ['**/context/MarketplaceContext*'],
            message: 'Use selector hooks from context barrel, not raw MarketplaceContext.',
          },
          // Convention 7: Barrel imports for cache module internals
          {
            group: ['**/cache/CacheManager*'],
            message: 'Import from cache barrel (cache/index.ts), not CacheManager directly.',
          },
          {
            group: ['**/cache/FetchScheduler*'],
            message: 'Import from cache barrel (cache/index.ts), not FetchScheduler directly.',
          },
          // Convention 8: Barrel imports for ui/ and hooks/ internals
          {
            group: ['**/ui/Modal/Modal'],
            message: "Import Modal from the ui barrel ('../../ui'), not from ui/Modal/Modal directly.",
          },
          {
            group: ['**/ui/processorBadgeTypes'],
            message: "Import from the ui barrel ('../../ui'), not from ui/processorBadgeTypes directly.",
          },
          {
            group: ['**/hooks/useMarketplace'],
            message: "Import from the hooks barrel ('../../hooks'), not from hooks/useMarketplace directly.",
          },
        ],
      }],
    },
  },

  // ── Block 3: Exception overrides ────────────────────────────────────

  // context/ and cache/ export hooks alongside providers — not HMR targets
  {
    files: ['src-next/context/**/*.{ts,tsx}', 'src-next/cache/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // bridge/types.ts — defines isBugreportLike, needs the literal strings
  {
    files: ['src-next/bridge/types.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // bridge/commands.ts — authorized invoke()/Channel caller
  {
    files: ['src-next/bridge/commands.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // bridge/events.ts — authorized listen() caller
  {
    files: ['src-next/bridge/events.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // hooks/usePipeline.ts, hooks/useStateTracker.ts — allowed listen() but NOT invoke()
  {
    files: ['src-next/hooks/usePipeline.ts', 'src-next/hooks/useStateTracker.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@tauri-apps/api/core'],
            importNames: ['invoke', 'Channel'],
            message: 'Use bridge/commands wrappers instead of direct invoke()/Channel.',
          },
          // listen() is allowed for these two hooks — omitted from patterns
        ],
      }],
    },
  },
);
