/**
 * Export store (W8): fetches session/processor counts, tracks the
 * include-toggles + anonymize opt-in, and runs the `.lts` export once a
 * destination is chosen. Mirrors React's `ExportModal.tsx`; `editorTabs` is
 * always `[]` here — Solid has no multi-tab editor/workspace state yet
 * (see implementation-notes).
 */
import { createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import * as cmds from '@bridge/commands';
import type { ExportAllOptions, ExportAllSessionsInfo } from '@bridge/types';
export type ExportCommands = Pick<typeof cmds, 'getExportAllSessionsInfo' | 'exportAllSessions'>;
export interface ExportStoreDeps {
  /** Injected for tests; defaults to the real bridge commands. */
  commands?: Partial<ExportCommands>;
}
export interface ExportOptionsState {
  includeBookmarks: boolean; includeAnalyses: boolean; includeProcessors: boolean;
  /** Ui-only "Anonymize PII in exported log lines" opt-in — see `ExportAllOptions.anonymize`. */
  anonymize: boolean;
}
const DEFAULT_OPTIONS: ExportOptionsState = { includeBookmarks: true, includeAnalyses: true, includeProcessors: true, anonymize: false };
export interface ExportStore {
  info: Accessor<ExportAllSessionsInfo | null>; loading: Accessor<boolean>; exporting: Accessor<boolean>;
  /** Verbatim message from the last failed `refresh`/`runExport` (e.g. a B3 policy-gate rejection). */
  error: Accessor<string | null>;
  options: Accessor<ExportOptionsState>;
  setOption<K extends keyof ExportOptionsState>(key: K, value: ExportOptionsState[K]): void;
  /** Fetches session/processor counts. Call each time the surface opens. */
  refresh(): void;
  /** Runs the export against an already-chosen destination (the save dialog is the UI's job). */
  runExport(destPath: string): Promise<void>;
  dispose(): void;
}
export function createExportStore(deps: ExportStoreDeps = {}): ExportStore {
  const c: ExportCommands = { ...cmds, ...deps.commands };
  return createRoot((disposeRoot) => {
    const [info, setInfo] = createSignal<ExportAllSessionsInfo | null>(null);
    const [loading, setLoading] = createSignal(false);
    const [exporting, setExporting] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);
    const [options, setOptions] = createSignal<ExportOptionsState>(DEFAULT_OPTIONS);
    let disposed = false;
    const refresh = (): void => {
      setLoading(true);
      setError(null);
      c.getExportAllSessionsInfo()
        .then((data) => { if (!disposed) setInfo(data); })
        .catch((e: unknown) => { if (!disposed) setError(String(e)); })
        .finally(() => { if (!disposed) setLoading(false); });
    };
    const setOption = <K extends keyof ExportOptionsState>(key: K, value: ExportOptionsState[K]): void => {
      setOptions((prev) => ({ ...prev, [key]: value }));
    };
    const runExport = (destPath: string): Promise<void> => {
      const payload: ExportAllOptions = { destPath, editorTabs: [], ...options() };
      setExporting(true);
      setError(null);
      return c.exportAllSessions(payload)
        .catch((e: unknown) => { if (!disposed) setError(String(e)); throw e; })
        .finally(() => { if (!disposed) setExporting(false); });
    };
    const dispose = (): void => { disposed = true; disposeRoot(); };
    return { info, loading, exporting, error, options, setOption, refresh, runExport, dispose };
  });
}
