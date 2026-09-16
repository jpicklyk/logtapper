import { createRequire } from 'module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import solid from 'eslint-plugin-solid/configs/typescript';

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
      // ── Convention 5: No direct listen() outside bridge ─────────────
      // ── Convention 9: No deprecated useViewerActions ────────────────
      // ── Convention 10: No deprecated useSessionContext ──────────────
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
          {
            group: ['**/context/SessionContext*'],
            importNames: ['useSessionContext'],
            message: 'useSessionContext is deprecated. Use useSessionCoreCtx, useSessionPaneCtx, or useSessionProgressCtx directly.',
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
      // Keep component files focused. Files over 400 meaningful lines are a
      // signal to split into sub-components or extract hooks. Warn (not error)
      // for gradual adoption — existing large files get warnings, not failures.
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
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
          // Convention 10: No deprecated useSessionContext
          {
            group: ['**/context/SessionContext*'],
            importNames: ['useSessionContext'],
            message: 'useSessionContext is deprecated. Use useSessionCoreCtx, useSessionPaneCtx, or useSessionProgressCtx directly.',
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
          // Convention 8: Barrel imports for ui/, hooks/, and viewport/ internals
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
          {
            group: ['**/viewport/FetchScheduler*'],
            message: 'FetchScheduler is internal to viewport/ (used only by useFetchScheduler) — not exported from the barrel.',
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

  // ── Block 4: src-solid/ — parallel Solid frontend ──────────────────
  // Disjoint from every React block above. The Solid app may only reach into
  // src-next/ through the framework-free modules the aliases expose.
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
        paths: [
          {
            name: '@viewport',
            message: 'The viewport barrel re-exports React .tsx — import the framework-free module directly (e.g. @viewport/FetchScheduler).',
          },
          {
            name: '@cache',
            message: 'The cache barrel re-exports React .tsx — import @cache/CacheManager directly.',
          },
        ],
        patterns: [
          {
            group: ['**/src-next/**/*.tsx', '@*/**/*.tsx'],
            message: 'React components are not importable from src-solid/.',
          },
          {
            group: ['**/src-next/context/**', '**/src-next/hooks/**', '**/src-next/components/**'],
            message: 'src-next/ context, hooks and components are React-only — not shared with src-solid/.',
          },
          // The `@hooks` alias exists for one framework-free file. Everything
          // else under src-next/hooks/ is React and stays unreachable. This has
          // to be a `regex` with a negative lookahead rather than a `group`
          // with a `!` entry: `group` is matched by the `ignore` package, whose
          // gitignore semantics refuse to re-include a path once a parent
          // directory pattern has excluded it — so the negation is silently
          // inert. Extend the alternation, by exact file path, to widen it.
          {
            regex:
              '^@hooks/(?!useLogViewer/multiSessionImport$|workspace/appStatePayload$|workspace/reconcileWorkspaceList$|workspace/restorePlan$|workspace/artifactPairing$|workspace/startupFile$|workspace/restoreTrust$|pipelineChainStorage$).*',
            message:
              'Only the framework-free files on the @hooks allow-list are shared with src-solid/ — the rest of src-next/hooks/ is React-only. Extend the alternation in eslint.config.js by exact file path.',
          },
          // Same pattern as `@hooks`: `@fileinfo` reaches into React territory
          // (`src-next/components/FileInfoPanel/`), so only the three
          // framework-free modules W3 reuses are let through.
          {
            regex: '^@fileinfo/(?!sectionTree$|formatters$|sectionDescriptions$).*',
            message:
              'Only sectionTree, formatters and sectionDescriptions are shared with src-solid/ — the rest of FileInfoPanel/ is React-only. Extend the alternation in eslint.config.js by exact file path.',
          },
          // Same file-level allow-list pattern as `@hooks`, for the one
          // framework-free file under src-next/components/ProcessorDashboard/.
          {
            regex: '^@procdash/(?!utils$).*',
            message:
              'Only @procdash/utils (framework-free) is shared with src-solid/ — the rest of ProcessorDashboard/ is React-only. Extend the alternation in eslint.config.js by exact file path.',
          },
          // Same pattern as `@hooks`/`@fileinfo`: `@analysisPanel` reaches into
          // React territory (`src-next/components/AnalysisPanel/`), so only the
          // one framework-free module W6 reuses is let through.
          {
            regex: '^@analysisPanel/(?!analysisAttribution$).*',
            message:
              'Only analysisAttribution (framework-free) is shared with src-solid/ — the rest of AnalysisPanel/ is React-only. Extend the alternation in eslint.config.js by exact file path.',
          },
          // Same pattern, for the one framework-free file under
          // `src-next/components/AnalysisReader/`.
          {
            regex: '^@analysisReader/(?!pendingSelection$).*',
            message:
              'Only pendingSelection (framework-free) is shared with src-solid/ — the rest of AnalysisReader/ is React-only. Extend the alternation in eslint.config.js by exact file path.',
          },
          // Same file-level allow-list pattern again, for the one
          // framework-free file under src-next/components/StateTimeline/.
          {
            regex: '^@statetimeline/(?!timelineUtils$).*',
            message:
              'Only @statetimeline/timelineUtils (framework-free) is shared with src-solid/ — the rest of StateTimeline/ is React-only. Extend the alternation in eslint.config.js by exact file path.',
          },
          // Same pattern, for the one framework-free file under
          // `src-next/components/BookmarkPanel/`.
          {
            regex: '^@bookmarkPanel/(?!exportMarkdown$).*',
            message:
              'Only exportMarkdown (framework-free) is shared with src-solid/ — the rest of BookmarkPanel/ is React-only. Extend the alternation in eslint.config.js by exact file path.',
          },
          // Same pattern, for the one framework-free file under
          // `src-next/components/LogViewer/` — the absolute-line ↔
          // rendered-index binary search the Solid viewer reuses verbatim.
          {
            regex: '^@logviewer/(?!scrollMapping$).*',
            message:
              'Only scrollMapping (framework-free) is shared with src-solid/ — the rest of components/LogViewer/ is React-only. Extend the alternation in eslint.config.js by exact file path.',
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

);
