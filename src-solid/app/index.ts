/**
 * Public API of the app layer: session state, the action surface, and the
 * bench driver. `App.tsx` composes these; nothing else constructs them.
 */
export { createSessionStore, viewIdFor } from './sessions';
export type {
  SessionEntry,
  SessionEntryKind,
  SessionStore,
  SessionStoreDeps,
  SearchQueryProvider,
} from './sessions';

export { createAppActions, MAIN_PANE_ID, INDEX_PROBE_MS, INDEX_PROBE_TIMEOUT_MS } from './actions';
export type { AppActions, AppActionsDeps, OpenPathOptions } from './actions';

export { installBenchApp, isBenchMode } from './benchDriver';
export type { BenchApp, BenchDriverDeps } from './benchDriver';

export { classifyShortcut, installShortcuts } from './shortcuts';
export type { ShortcutAction, ShortcutActions } from './shortcuts';
