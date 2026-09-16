/** Settings store (W8): data behind the `settings` surface's four tabs
 *  (General/PII/Themes/Sources). MCP status is NOT polled here — `App.tsx`
 *  passes A2's `presenceStore.status` straight through, so there is one poll. */
import { createRoot, createSignal, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import * as cmds from '@bridge/commands';
import type {
  AnonymizerConfig, AnonymizerTestResult, FileAssocEntry, McpOpenAllowlist, McpStatus, Source, ThemeSummary, UserTheme,
} from '@bridge/types';
import { validateUserTheme } from '../theme';
export type SettingsCommands = Pick<typeof cmds,
  | 'getAnonymizerConfig' | 'setAnonymizerConfig' | 'testAnonymizer' | 'getPiiMappings' | 'getFileAssociationStatus'
  | 'setFileAssociation' | 'openDefaultAppsSettings' | 'getMcpOpenAllowlist' | 'setMcpOpenAllowlist' | 'setAgentRawAccess'
  | 'startMcpBridge' | 'stopMcpBridge' | 'listThemes' | 'readTheme' | 'writeTheme' | 'deleteTheme' | 'readTextFile'
  | 'writeTextFile' | 'listSources' | 'addSource' | 'removeSource'>;
export interface SettingsStoreDeps {
  /** A2's bridge-status accessor (`presenceStore.status`) — read-only here. */
  mcpStatus: Accessor<McpStatus | null>;
  /**
   * A2's `presenceStore.refreshStatus` — forces an immediate re-read of
   * `McpStatus` instead of waiting out the ≤5 s poll. Called after the two
   * security-relevant writes (`setAgentRawAccess`, `setMcpBridgeEnabled`) so the
   * checkbox that governs whether agents see raw log text reflects the backend's
   * answer to *this* write, not the one before it. The backend stays the single
   * source of truth — this only re-reads it sooner; it never mirrors it.
   * Optional so a host that has no presence store still builds a settings store.
   */
  refreshMcpStatus?: () => void;
  commands?: Partial<SettingsCommands>; // injected for tests; defaults to the real bridge commands
  /** Where the shared `logtapper_settings` preference blob lives; defaults to `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** React's persisted settings blob (`src-next/hooks/useSettings.ts` `STORAGE_KEY`). Solid reads
 *  and writes only `mcpBridgeEnabled` in it, read-modify-write, so the two UIs agree on whether
 *  the bridge auto-starts and neither drops the other's keys. */
export const SHARED_SETTINGS_KEY = 'logtapper_settings';

function readSharedSettings(storage: Pick<Storage, 'getItem'> | undefined): Record<string, unknown> {
  try {
    const raw = storage?.getItem(SHARED_SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
export interface SettingsStore {
  mcpStatus: Accessor<McpStatus | null>; mcpBridgePending: Accessor<boolean>; setMcpBridgeEnabled(enabled: boolean): Promise<void>;
  /** The persisted "the bridge should be running" preference — distinct from
   *  `mcpStatus()?.running`, which is whether it *is*. The gap between them is
   *  the "starting…" window. */
  mcpBridgeEnabled: Accessor<boolean>;
  agentRawAccessPending: Accessor<boolean>; setAgentRawAccess(enabled: boolean): Promise<void>;
  allowlist: Accessor<McpOpenAllowlist | null>; refreshAllowlist(): void;
  addAllowDir(dir: string): Promise<void>; removeAllowDir(dir: string): Promise<void>; setAllowAll(allowAll: boolean): Promise<void>;
  fileAssociations: Accessor<FileAssocEntry[]>; refreshFileAssociations(): void;
  setFileAssociation(ext: string, enabled: boolean): Promise<void>; openDefaultAppsSettings(): void;
  anonymizerConfig: Accessor<AnonymizerConfig | null>; refreshAnonymizerConfig(): void; toggleDetector(id: string, enabled: boolean): Promise<void>;
  testResult: Accessor<AnonymizerTestResult | null>; runAnonymizerTest(text: string): Promise<AnonymizerTestResult>;
  piiMappings: Accessor<Record<string, string>>; refreshPiiMappings(sessionId: string): Promise<void>;
  themes: Accessor<ThemeSummary[]>; refreshThemes(): void; readTheme(slug: string): Promise<UserTheme>;
  saveTheme(slug: string, theme: UserTheme): Promise<void>; deleteTheme(slug: string): Promise<void>;
  /** Reads `path` as JSON, validates as a `UserTheme`, stores under `slug`. */
  importThemeFromFile(path: string, slug: string): Promise<UserTheme>;
  exportThemeToFile(path: string, theme: UserTheme): Promise<void>;
  sources: Accessor<Source[]>; refreshSources(): void; addSource(source: Source): Promise<void>; removeSource(name: string): Promise<void>;
  /** Verbatim message from the last rejected command; `null` once dismissed or
   *  once a fresh mutation starts. `SettingsPanel` renders it. */
  error: Accessor<string | null>; clearError(): void; dispose(): void;
}
export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const c: SettingsCommands = { ...cmds, ...deps.commands };
  const mcpStatus = deps.mcpStatus;
  const refreshMcpStatus = deps.refreshMcpStatus;
  const storage = deps.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  const writeBridgePreference = (enabled: boolean): void => {
    try {
      storage?.setItem(SHARED_SETTINGS_KEY, JSON.stringify({ ...readSharedSettings(storage), mcpBridgeEnabled: enabled }));
    } catch {
      // a full or unavailable storage must never fail the toggle itself
    }
  };
  return createRoot((disposeRoot) => {
    const [mcpBridgePending, setMcpBridgePending] = createSignal(false);
    const [agentRawAccessPending, setAgentRawAccessPending] = createSignal(false);
    const [allowlist, setAllowlist] = createSignal<McpOpenAllowlist | null>(null);
    const [fileAssociations, setFileAssociations] = createSignal<FileAssocEntry[]>([]);
    const [anonymizerConfig, setAnonymizerConfig] = createSignal<AnonymizerConfig | null>(null);
    const [testResult, setTestResult] = createSignal<AnonymizerTestResult | null>(null);
    const [piiMappings, setPiiMappings] = createSignal<Record<string, string>>({});
    const [themes, setThemes] = createSignal<ThemeSummary[]>([]);
    const [sources, setSources] = createSignal<Source[]>([]);
    const [error, setError] = createSignal<string | null>(null);
    const [mcpBridgeEnabled, setMcpBridgeEnabledSignal] = createSignal(readSharedSettings(storage).mcpBridgeEnabled === true);
    let disposed = false;
    const fail = (e: unknown): void => { if (!disposed) setError(String(e)); };
    const clearError = (): void => { if (!disposed) setError(null); };
    /** Fetch-on-demand: resolves `cmd()` into `set`; a rejection reports to `error` and is swallowed.
     *  Deliberately does NOT clear `error` first: `persistAllowlist` calls `refreshAllowlist()` from
     *  its own rejection path, and a clear here would erase the message that rejection just wrote. */
    function load<T>(cmd: () => Promise<T>, set: (v: T) => void, fallback?: T): void {
      cmd().then((v) => { if (!disposed) set(v); }).catch((e: unknown) => {
        fail(e);
        if (!disposed && fallback !== undefined) set(fallback);
      });
    }
    /** A write whose rejection must reach the caller, while also recording it in `error`.
     *  Each write starts from a clean slate so a stale failure never outlives the retry that fixed it. */
    const mutate = <T,>(p: Promise<T>): Promise<T> => {
      clearError();
      return p.catch((e: unknown) => { fail(e); throw e; });
    };
    const persistBridgePreference = (enabled: boolean): void => {
      setMcpBridgeEnabledSignal(enabled);
      writeBridgePreference(enabled);
    };
    // General
    const setMcpBridgeEnabled = (enabled: boolean): Promise<void> => {
      setMcpBridgePending(true);
      return mutate(enabled ? c.startMcpBridge() : c.stopMcpBridge())
        .then(() => persistBridgePreference(enabled))
        // Re-read `McpStatus` rather than wait out A2's ≤5 s poll: until it lands the
        // UI cannot say whether the bridge is actually up (M6).
        .finally(() => { if (!disposed) setMcpBridgePending(false); refreshMcpStatus?.(); });
    };
    // Same launch behaviour as the React shell (`useAppShellSetup.ts`): the bridge starts on
    // its own when the saved preference says so, so an agent finds it without a manual toggle.
    // Untracked: a one-time read of the seeded preference at construction, not a subscription.
    if (untrack(mcpBridgeEnabled)) {
      c.startMcpBridge().catch(fail);
    }
    const setAgentRawAccess = (enabled: boolean): Promise<void> => {
      setAgentRawAccessPending(true);
      return mutate(c.setAgentRawAccess(enabled))
        // Security-relevant: the checkbox reflects `McpStatus.agentRawAccess` (the backend's
        // truth, never a local mirror), so a rejected write must be corrected by a re-read,
        // not left showing the optimistic DOM state for up to a poll interval (M6).
        .finally(() => { if (!disposed) setAgentRawAccessPending(false); refreshMcpStatus?.(); });
    };
    const refreshAllowlist = (): void => load(c.getMcpOpenAllowlist, setAllowlist, { allowedDirs: [], allowAll: false });
    const persistAllowlist = (next: McpOpenAllowlist): Promise<void> => {
      setAllowlist(next);
      return mutate(c.setMcpOpenAllowlist(next.allowedDirs, next.allowAll)).catch((e) => { refreshAllowlist(); throw e; });
    };
    const addAllowDir = (dir: string): Promise<void> => {
      const prev = allowlist();
      return !prev || prev.allowedDirs.includes(dir) ? Promise.resolve() : persistAllowlist({ ...prev, allowedDirs: [...prev.allowedDirs, dir] });
    };
    const removeAllowDir = (dir: string): Promise<void> => {
      const prev = allowlist();
      return prev ? persistAllowlist({ ...prev, allowedDirs: prev.allowedDirs.filter((d) => d !== dir) }) : Promise.resolve();
    };
    const setAllowAll = (allowAll: boolean): Promise<void> => {
      const prev = allowlist();
      return prev ? persistAllowlist({ ...prev, allowAll }) : Promise.resolve();
    };
    const refreshFileAssociations = (): void => load(c.getFileAssociationStatus, setFileAssociations, []);
    const setFileAssociation = (ext: string, enabled: boolean): Promise<void> =>
      mutate(c.setFileAssociation(ext, enabled)).then(() => refreshFileAssociations());
    const openDefaultAppsSettings = (): void => { c.openDefaultAppsSettings().catch(() => undefined); };
    // PII
    const refreshAnonymizerConfig = (): void => load(c.getAnonymizerConfig, setAnonymizerConfig);
    const toggleDetector = (id: string, enabled: boolean): Promise<void> => {
      const prev = anonymizerConfig();
      if (!prev) return Promise.resolve();
      const next: AnonymizerConfig = { detectors: prev.detectors.map((d) => (d.id === id ? { ...d, enabled } : d)) };
      setAnonymizerConfig(next);
      return mutate(c.setAnonymizerConfig(next)).catch((e) => { refreshAnonymizerConfig(); throw e; });
    };
    const runAnonymizerTest = (text: string): Promise<AnonymizerTestResult> =>
      mutate(c.testAnonymizer(text)).then((r) => { if (!disposed) setTestResult(r); return r; });
    const refreshPiiMappings = (sessionId: string): Promise<void> =>
      mutate(c.getPiiMappings(sessionId)).then((m) => { if (!disposed) setPiiMappings(m); });
    // Themes
    const refreshThemes = (): void => load(c.listThemes, setThemes, []);
    const saveTheme = (slug: string, theme: UserTheme): Promise<void> =>
      mutate(c.writeTheme(slug, theme)).then(() => refreshThemes());
    const deleteThemeFn = (slug: string): Promise<void> => mutate(c.deleteTheme(slug)).then(() => refreshThemes());
    const importThemeFromFile = (path: string, slug: string): Promise<UserTheme> =>
      mutate(c.readTextFile(path)).then((raw) => {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { throw new Error('theme file is not valid JSON'); }
        const result = validateUserTheme(parsed);
        if (!result.valid || !result.theme) throw new Error(result.errors.join('; '));
        return mutate(c.writeTheme(slug, result.theme)).then(() => { refreshThemes(); return result.theme!; });
      });
    const exportThemeToFile = (path: string, theme: UserTheme): Promise<void> =>
      mutate(c.writeTextFile(path, JSON.stringify(theme, null, 2)));
    // Sources
    const refreshSources = (): void => load(c.listSources, setSources, []);
    const addSourceFn = (source: Source): Promise<void> => mutate(c.addSource(source)).then(() => refreshSources());
    const removeSourceFn = (name: string): Promise<void> => mutate(c.removeSource(name)).then(() => refreshSources());
    const dispose = (): void => { disposed = true; disposeRoot(); };
    return {
      mcpStatus, mcpBridgePending, setMcpBridgeEnabled, mcpBridgeEnabled, agentRawAccessPending, setAgentRawAccess,
      allowlist, refreshAllowlist, addAllowDir, removeAllowDir, setAllowAll,
      fileAssociations, refreshFileAssociations, setFileAssociation, openDefaultAppsSettings,
      anonymizerConfig, refreshAnonymizerConfig, toggleDetector, testResult, runAnonymizerTest,
      piiMappings, refreshPiiMappings,
      themes, refreshThemes, readTheme: c.readTheme, saveTheme, deleteTheme: deleteThemeFn,
      importThemeFromFile, exportThemeToFile,
      sources, refreshSources, addSource: addSourceFn, removeSource: removeSourceFn,
      error, clearError, dispose,
    };
  });
}
