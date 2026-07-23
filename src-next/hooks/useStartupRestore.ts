import { useEffect, useRef } from 'react';
import { useWorkspaceContext } from '../context/WorkspaceContext';
import { loadWorkspaceV4 } from '../bridge/commands';
import type { LoadWorkspaceV4Result } from '../bridge/types';
import type { WorkspaceIdentity } from '../bridge/workspaceTypes';
import { bus } from '../events/bus';
import { storageGetJSON, storageRemove } from '../utils';
import { getStoredLogviewerTabs, collectEditorTabsForSave, readTabPaths } from './workspace/workspacePersistence';
import { STORAGE_KEY } from './workspace/workspaceTypes';
import {
  assessRestoreCandidate,
  type RestoreManifestHeader,
} from './workspace/restoreTrust';
import { planStartupRestore, type StoredTab } from './workspace/restorePlan';
import { restoreWorkspace, type RestoreIo } from './workspace/restoreCore';
import { consumeStartupFile } from './workspace/startupFile';
import { pushWorkspaceEnvelope } from './workspace/envelopeSync';

/**
 * The single startup restore orchestrator (design:
 * `plans/workspace-restore-design.md` §Q2). Mounted once in `HookWiring`,
 * replacing the inline localStorage replay that used to live in
 * `useFileSession.ts`. Sequence:
 *
 *   1. Await Q1 hydration (app-state.json is authoritative).
 *   2. A CLI startup file (double-click) wins — `useStartupFile` loads it; this
 *      orchestrator then only replays the localStorage tabs (matching the prior
 *      behaviour) and skips the `.ltw` trust gate.
 *   3. Otherwise run Q3's gate on the active workspace's candidate `.ltw`:
 *      - trusted  → restore the `.ltw` (unioned with localStorage tabs).
 *      - untrusted → localStorage-only restore + a non-blocking notice.
 *      - absent    → localStorage-only restore, silently.
 *   4. Always push the backend envelope at the end (Q4) so an early MCP write's
 *      flush has a shell to write instead of logging-and-skipping.
 *
 * One-shot (`hasStartedRef`) + `cancelled` guard for StrictMode safety.
 */
export interface StartupRestoreDeps extends RestoreIo {
  /** Live pipeline chain (for the envelope push on the localStorage path). */
  getPipelineChain: () => string[];
  getDisabledChainIds: () => string[];
}

export function useStartupRestore(deps: StartupRestoreDeps): void {
  const wsCtx = useWorkspaceContext();
  const { hydrated } = wsCtx;

  const wsCtxRef = useRef(wsCtx);
  wsCtxRef.current = wsCtx;
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (!hydrated) return;
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    let cancelled = false;

    const io: RestoreIo = {
      loadFile: (path, paneId, existingTabId) => depsRef.current.loadFile(path, paneId, existingTabId),
      scheduleAutoRun: (sessionId, isIndexing, chain, disabled) =>
        depsRef.current.scheduleAutoRun(sessionId, isIndexing, chain, disabled),
    };

    const readStoredTabs = (): StoredTab[] => getStoredLogviewerTabs();
    const hasLocalLayout = (): boolean => storageGetJSON<unknown>(STORAGE_KEY, null) !== null;

    /** Mirror of `doLoadWorkspace`'s end-of-restore envelope push. */
    const pushEnvelope = (ws: WorkspaceIdentity, override?: {
      workspaceName?: string; ltwPath?: string | null;
      editorTabs?: ReturnType<typeof collectEditorTabsForSave>; layout?: unknown;
      pipelineChain?: string[]; disabledChainIds?: string[];
    }): void => {
      void pushWorkspaceEnvelope({
        workspaceId: ws.id,
        workspaceName: override?.workspaceName ?? ws.name,
        ltwPath: override?.ltwPath ?? ws.filePath,
        editorTabs: override?.editorTabs ?? collectEditorTabsForSave(),
        layout: override?.layout ?? storageGetJSON<unknown>(STORAGE_KEY, null),
        pipelineChain: override?.pipelineChain ?? depsRef.current.getPipelineChain(),
        disabledChainIds: override?.disabledChainIds ?? depsRef.current.getDisabledChainIds(),
      }, '[useStartupRestore]');
    };

    const surfaceWarnings = (warnings: string[]): void => {
      if (warnings.length > 0) bus.emit('workspace:restore-warnings', { warnings });
    };

    /** Run the pure-localStorage plan (today's replay through the same core). */
    const restoreLocalStorageOnly = async (active: WorkspaceIdentity): Promise<void> => {
      const plan = planStartupRestore({
        sessions: [],
        storedTabs: readStoredTabs(), tabPaths: readTabPaths(), hasLocalLayout: hasLocalLayout(),
      });
      const warnings = await restoreWorkspace(
        { workspaceName: active.name, filePath: '', sessionData: [], editorTabs: [], layout: null },
        plan, io,
      );
      if (cancelled) return;
      surfaceWarnings(warnings);
      pushEnvelope(active);
    };

    const run = async (): Promise<void> => {
      // Preserve the cleanup the old useFileSession replay performed.
      storageRemove('logtapper_last_file');

      const active = wsCtxRef.current.activeWorkspace;
      if (!active) return;

      // (b) CLI startup file wins — useStartupFile loads it; we only replay the
      // localStorage tabs (matching the prior startup) and skip the `.ltw` gate.
      const startupPath = await consumeStartupFile();
      if (cancelled) return;
      if (startupPath) {
        await restoreLocalStorageOnly(active);
        return;
      }

      // (c) Resolve the active entry's candidate `.ltw` and run Q3's gate.
      const readCache = new Map<string, LoadWorkspaceV4Result | null>();
      const readWorkspace = async (path: string): Promise<LoadWorkspaceV4Result | null> => {
        if (readCache.has(path)) return readCache.get(path) ?? null;
        const r = await loadWorkspaceV4(path).catch(() => null);
        readCache.set(path, r);
        return r;
      };
      const toHeader = (r: LoadWorkspaceV4Result | null): RestoreManifestHeader | null =>
        r ? { workspaceId: r.workspaceId, savedAt: r.savedAt, sessionPaths: r.sessions.map((s) => s.filePath) } : null;

      const entry = {
        id: active.id,
        ltwPath: active.filePath,
        dirty: active.dirty,
        autoSavePath: active.autoSavePath ?? null,
        lastAutoSaveAt: active.lastAutoSaveAt ?? null,
      };

      // Independent reads — run in parallel rather than awaiting one before
      // starting the other.
      const [autoResult, explicitResult] = await Promise.all([
        entry.autoSavePath ? readWorkspace(entry.autoSavePath) : Promise.resolve(null),
        entry.ltwPath ? readWorkspace(entry.ltwPath) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      const autoHeader = toHeader(autoResult);
      const explicitHeader = toHeader(explicitResult);

      const localTabPaths = Object.values(readTabPaths());
      const assessment = assessRestoreCandidate(entry, { autoSave: autoHeader, explicit: explicitHeader }, localTabPaths);

      // (d) Trusted → restore the already-read `.ltw`; else localStorage plan.
      if (assessment.verdict === 'trusted' && assessment.candidatePath) {
        const result = readCache.get(assessment.candidatePath) ?? null;
        if (!result) {
          await restoreLocalStorageOnly(active);
          return;
        }
        const plan = planStartupRestore({
          sessions: result.sessions,
          storedTabs: readStoredTabs(),
          tabPaths: readTabPaths(),
          hasLocalLayout: hasLocalLayout(),
        });
        const warnings = await restoreWorkspace(
          {
            workspaceName: result.workspaceName,
            filePath: assessment.candidatePath,
            sessionData: result.sessionData,
            editorTabs: result.editorTabs,
            layout: result.layout,
          },
          plan, io,
        );
        if (cancelled) return;
        surfaceWarnings(warnings);
        pushEnvelope(active, {
          workspaceName: result.workspaceName,
          ltwPath: assessment.candidatePath,
          editorTabs: result.editorTabs,
          layout: result.layout,
          pipelineChain: result.pipelineChain.chain,
          disabledChainIds: result.pipelineChain.disabledIds,
        });
        return;
      }

      // untrusted / absent → localStorage plan (no regression from prior startup).
      await restoreLocalStorageOnly(active);
      if (cancelled) return;

      if (assessment.verdict === 'untrusted' && assessment.candidatePath) {
        const candResult = readCache.get(assessment.candidatePath) ?? null;
        bus.emit('workspace:untrusted-autosave', {
          workspaceId: entry.id,
          candidatePath: assessment.candidatePath,
          savedAt: candResult?.savedAt ?? 0,
          reasons: assessment.reasons,
        });
      }
    };

    void run().catch((e: unknown) => console.warn('[useStartupRestore] restore failed:', e));

    return () => { cancelled = true; };
  }, [hydrated]);
}
