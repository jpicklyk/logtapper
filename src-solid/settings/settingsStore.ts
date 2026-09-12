/** Settings store (W8): data behind the `settings` surface's four tabs
 *  (General/PII/Themes/Sources). MCP status is NOT polled here — `App.tsx`
 *  passes A2's `presenceStore.status` straight through, so there is one poll. */
import { createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import * as cmds from '@bridge/commands';
import type {
  AnonymizerConfig, AnonymizerTestResult, FileAssocEntry, McpOpenAllowlist, McpStatus, Source, ThemeSummary, UserTheme,
} from '@bridge/types';
import { validateUserTheme } from '../theme/userTheme';
export type SettingsCommands = Pick<typeof cmds,
  | 'getAnonymizerConfig' | 'setAnonymizerConfig' | 'testAnonymizer' | 'getPiiMappings' | 'getFileAssociationStatus'
  | 'setFileAssociation' | 'openDefaultAppsSettings' | 'getMcpOpenAllowlist' | 'setMcpOpenAllowlist' | 'setAgentRawAccess'
  | 'startMcpBridge' | 'stopMcpBridge' | 'listThemes' | 'readTheme' | 'writeTheme' | 'deleteTheme' | 'readTextFile'
  | 'writeTextFile' | 'listSources' | 'addSource' | 'removeSource'>;
export interface SettingsStoreDeps {
  /** A2's bridge-status accessor (`presenceStore.status`) — read-only here. */
  mcpStatus: Accessor<McpStatus | null>;
  commands?: Partial<SettingsCommands>; // injected for tests; defaults to the real bridge commands
}
export interface SettingsStore {
  mcpStatus: Accessor<McpStatus | null>; mcpBridgePending: Accessor<boolean>; setMcpBridgeEnabled(enabled: boolean): Promise<void>;
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
  error: Accessor<string | null>; dispose(): void;
}
export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const c: SettingsCommands = { ...cmds, ...deps.commands };
  const mcpStatus = deps.mcpStatus;
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
    let disposed = false;
    const fail = (e: unknown): void => { if (!disposed) setError(String(e)); };
    /** Fetch-on-demand: resolves `cmd()` into `set`; a rejection reports to `error` and is swallowed. */
    function load<T>(cmd: () => Promise<T>, set: (v: T) => void, fallback?: T): void {
      cmd().then((v) => { if (!disposed) set(v); }).catch((e: unknown) => {
        fail(e);
        if (!disposed && fallback !== undefined) set(fallback);
      });
    }
    /** A write whose rejection must reach the caller, while also recording it in `error`. */
    const mutate = <T,>(p: Promise<T>): Promise<T> => p.catch((e: unknown) => { fail(e); throw e; });
    // General
    const setMcpBridgeEnabled = (enabled: boolean): Promise<void> => {
      setMcpBridgePending(true);
      return mutate(enabled ? c.startMcpBridge() : c.stopMcpBridge())
        .finally(() => { if (!disposed) setMcpBridgePending(false); });
    };
    const setAgentRawAccess = (enabled: boolean): Promise<void> => {
      setAgentRawAccessPending(true);
      return mutate(c.setAgentRawAccess(enabled))
        .finally(() => { if (!disposed) setAgentRawAccessPending(false); });
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
      mcpStatus, mcpBridgePending, setMcpBridgeEnabled, agentRawAccessPending, setAgentRawAccess,
      allowlist, refreshAllowlist, addAllowDir, removeAllowDir, setAllowAll,
      fileAssociations, refreshFileAssociations, setFileAssociation, openDefaultAppsSettings,
      anonymizerConfig, refreshAnonymizerConfig, toggleDetector, testResult, runAnonymizerTest,
      piiMappings, refreshPiiMappings,
      themes, refreshThemes, readTheme: c.readTheme, saveTheme, deleteTheme: deleteThemeFn,
      importThemeFromFile, exportThemeToFile,
      sources, refreshSources, addSource: addSourceFn, removeSource: removeSourceFn,
      error, dispose,
    };
  });
}
