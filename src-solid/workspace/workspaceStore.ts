/**
 * The one workspace store per Solid app: the workspace list and which one is
 * active, open/save/switch/autosave over the existing v4 commands, rename and
 * delete over B3's wrappers, and the crash-recovery mirror.
 *
 * It is the Solid counterpart of React's `WorkspaceContext` +
 * `useStartupRestore` + `useWorkspaceAutoSave` trio, but it reuses every
 * framework-free decision those hooks reuse — `buildAppStatePayload`,
 * `reconcileWorkspaceList`, `consumeStartupFile`, `planExplicitOpen` /
 * `planStartupRestore` — so the two frontends cannot drift on *what* a restore
 * should do, only on how the result is rendered.
 *
 * Lifetime: the store owns a `createRoot`, so `App` builds it as a plain
 * value. Every Tauri listener is unlistened by `dispose()`, including ones
 * whose `listen()` promise settles after dispose.
 *
 * Persistence layering, narrowest to widest:
 *  1. `app-state.json` (backend) — the authoritative workspace *list*. Read at
 *     `hydrate()`, reconciled with the in-memory list, written back on change.
 *  2. The `.ltw` file — the authoritative *content* of one workspace
 *     (sessions, artifacts, editor tabs, layout). Authoritative on an explicit
 *     open; unioned with the mirror at startup.
 *  3. The localStorage mirror — crash recovery only. See `restore.ts`'s
 *     "tab-mirror semantics".
 */
import { createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  autoSaveWorkspace,
  beginWorkspaceSwitch,
  deleteWorkspace,
  getAppState,
  loadWorkspaceV4,
  renameWorkspace,
  saveAppState,
  saveWorkspaceV4,
} from '@bridge/commands';
import {
  onWorkspaceAutoSaved,
  onWorkspaceListChanged,
  onWorkspaceRestored,
} from '@bridge/events';
import type { LtwEditorTab } from '@bridge/types';
import type { WorkspaceIdentity } from '@bridge/workspaceTypes';
import { createEmptyWorkspace } from '@bridge/workspaceTypes';
import { buildAppStatePayload } from '@hooks/workspace/appStatePayload';
import { reconcileWorkspaceList } from '@hooks/workspace/reconcileWorkspaceList';
import { consumeStartupFile } from '@hooks/workspace/startupFile';
import { planExplicitOpen, planStartupRestore } from '@hooks/workspace/restorePlan';
import type { RestorePlan, StoredTab } from '@hooks/workspace/restorePlan';
import type { LoadWorkspaceSessionData } from '@bridge/types';
import { emptySolidLayout, readSolidLayout, writeSolidLayout } from './layoutBlob';
import type { SolidLayout } from './layoutBlob';
import { runRestorePlan } from './restore';

/** localStorage key holding the crash-recovery mirror. Namespaced so it can
 *  never collide with React's `logtapper_workspace_list` / `logtapper_tab_paths`. */
export const SOLID_MIRROR_KEY = 'logtapper-solid-workspace';

/** Same debounce React's `useWorkspaceAutoSave` uses — a save is 3 s of quiet. */
export const AUTO_SAVE_DEBOUNCE_MS = 3000;

/** What the mirror holds: enough to reopen the last screen after a hard crash. */
export interface WorkspaceMirror {
  activeWorkspaceId: string | null;
  /** Absolute source paths of the open log tabs, in strip order. */
  tabPaths: string[];
  activeTabPath: string | null;
}

/** The shell's layout, read at save time and written at restore time. Supplied
 *  by whoever owns the shell (W1b) — the store never reaches into `shell/`. */
export interface ShellLayoutPort {
  read(): SolidLayout;
  apply(layout: SolidLayout): void;
}

/** The pipeline chain to stamp into a save. W4a injects the real one; the
 *  default writes an empty chain, which is what a chain-less workspace has. */
export interface PipelineChainSnapshot {
  chain: string[];
  disabledIds: string[];
}

/** The slice of W0b's session store this store reads. Structural on purpose —
 *  the real `SessionStore` satisfies it, and a test can pass a literal. */
export interface WorkspaceSessions {
  order(): readonly string[];
  focusedId(): string | null;
  byId(sessionId: string): { load: { filePath: string | null } } | undefined;
}

/** The slice of W0b's action surface this store drives. */
export interface WorkspaceSessionActions {
  openPath(path: string): Promise<string>;
  close(sessionId: string): Promise<void>;
}

export interface WorkspaceStoreDeps {
  sessions: WorkspaceSessions;
  actions: WorkspaceSessionActions;
  /** Optional: absent until W1b wires the real shell. */
  shellLayout?: ShellLayoutPort;
  /** Optional: W9 supplies the live editor tabs. Defaults to none. */
  getEditorTabs?: () => LtwEditorTab[];
  /** Optional: W4a supplies the live chain. Defaults to an empty chain. */
  getPipelineChain?: () => PipelineChainSnapshot;
  /** Injected in tests. Defaults to `window.localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  autoSaveDebounceMs?: number;
}

export interface WorkspaceStore {
  list: Accessor<readonly WorkspaceIdentity[]>;
  activeId: Accessor<string | null>;
  active: Accessor<WorkspaceIdentity | null>;
  dirty: Accessor<boolean>;
  /** Warnings from the most recent restore, for W1b to surface. */
  warnings: Accessor<readonly string[]>;
  /** Editor tabs a restore produced, waiting for W9 to adopt them. */
  pendingEditorTabs: Accessor<readonly LtwEditorTab[]>;
  /** Take the pending tabs, clearing them — W9 calls this once. */
  takePendingEditorTabs(): LtwEditorTab[];

  /** Mark the active workspace dirty and arm the auto-save debounce. */
  markMutated(): void;

  /** Read `app-state.json` and reconcile it with the in-memory list. */
  hydrate(): Promise<void>;
  /** Startup path: mirror ∪ the active workspace's `.ltw`, unless a CLI file wins. */
  startupRestore(): Promise<void>;
  /** Explicit open — the `.ltw` is authoritative. */
  openWorkspace(path: string): Promise<void>;
  /** Save to `path` (or the active workspace's own path, else auto-save). */
  saveWorkspace(path?: string): Promise<void>;
  /** Run a save now if the workspace is dirty and has an active id. */
  autoSave(): Promise<void>;
  switchWorkspace(id: string): Promise<void>;
  /**
   * Close everything and start a fresh, unsaved workspace — the "New
   * workspace" action. No `.ltw` is written; the new entry becomes active and
   * the list change is persisted like any other (W1b).
   */
  newWorkspace(): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  delete(id: string, options?: { deleteFile?: boolean; force?: boolean }): Promise<void>;

  dispose(): void;
}

function readMirror(storage: Pick<Storage, 'getItem' | 'setItem'>): WorkspaceMirror {
  const empty: WorkspaceMirror = { activeWorkspaceId: null, tabPaths: [], activeTabPath: null };
  try {
    const raw = storage.getItem(SOLID_MIRROR_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const m = parsed as Partial<WorkspaceMirror>;
    return {
      activeWorkspaceId: typeof m.activeWorkspaceId === 'string' ? m.activeWorkspaceId : null,
      tabPaths: Array.isArray(m.tabPaths) ? m.tabPaths.filter((p): p is string => typeof p === 'string') : [],
      activeTabPath: typeof m.activeTabPath === 'string' ? m.activeTabPath : null,
    };
  } catch {
    return empty;
  }
}

function writeMirror(storage: Pick<Storage, 'getItem' | 'setItem'>, mirror: WorkspaceMirror): void {
  try {
    storage.setItem(SOLID_MIRROR_KEY, JSON.stringify(mirror));
  } catch {
    /* private mode / quota — the mirror is best-effort by design. */
  }
}

/**
 * Shape the mirror's flat path list into the planner's `storedTabs`/`tabPaths`
 * pair. Solid has no pane tree, so every tab reports the single main pane and
 * the tab id *is* its index — the planner only uses those to re-associate a
 * manifest entry with an already-persisted tab slot, which for a flat strip is
 * exactly "the nth tab".
 */
export function mirrorToStoredTabs(mirror: WorkspaceMirror): {
  storedTabs: StoredTab[];
  tabPaths: Record<string, string>;
} {
  const storedTabs: StoredTab[] = [];
  const tabPaths: Record<string, string> = {};
  mirror.tabPaths.forEach((path, i) => {
    const tabId = `solid-tab-${i}`;
    storedTabs.push({ tabId, paneId: 'main', isActive: path === mirror.activeTabPath });
    tabPaths[tabId] = path;
  });
  return { storedTabs, tabPaths };
}

export function createWorkspaceStore(deps: WorkspaceStoreDeps): WorkspaceStore {
  return createRoot((disposeRoot) => {
    const storage = deps.storage ?? window.localStorage;
    const debounceMs = deps.autoSaveDebounceMs ?? AUTO_SAVE_DEBOUNCE_MS;
    const getEditorTabs = deps.getEditorTabs ?? ((): LtwEditorTab[] => []);
    const getChain = deps.getPipelineChain ?? ((): PipelineChainSnapshot => ({ chain: [], disabledIds: [] }));

    const [list, setList] = createSignal<readonly WorkspaceIdentity[]>([]);
    const [activeId, setActiveId] = createSignal<string | null>(null);
    const [warnings, setWarnings] = createSignal<readonly string[]>([]);
    const [pendingEditorTabs, setPendingEditorTabs] = createSignal<readonly LtwEditorTab[]>([]);

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Suppressed while a restore is in flight — saving then would rewrite what
     *  was just read, and a partial restore would overwrite a good `.ltw`. */
    let restoreDepth = 0;

    const active = (): WorkspaceIdentity | null =>
      list().find((w) => w.id === activeId()) ?? null;
    const dirty = (): boolean => active()?.dirty ?? false;

    const track = (p: Promise<UnlistenFn>): void => {
      void p.then((un) => {
        if (disposed) un();
        else unlisteners.push(un);
      }).catch(() => undefined);
    };

    const patch = (id: string, fields: Partial<WorkspaceIdentity>): void => {
      setList((prev) => prev.map((w) => (w.id === id ? { ...w, ...fields } : w)));
    };

    /** Write the current list back to `app-state.json`. Fire-and-forget: a
     *  failed write must not fail the user action that caused it. */
    const persistAppState = (): void => {
      void saveAppState(buildAppStatePayload(list(), activeId())).catch((e: unknown) =>
        console.warn('[workspaceStore] app-state write failed:', e),
      );
    };

    /** Mirror the open tab paths for crash recovery. */
    const persistMirror = (): void => {
      const paths: string[] = [];
      for (const id of deps.sessions.order()) {
        const path = deps.sessions.byId(id)?.load.filePath;
        if (path) paths.push(path);
      }
      const focused = deps.sessions.focusedId();
      writeMirror(storage, {
        activeWorkspaceId: activeId(),
        tabPaths: paths,
        activeTabPath: (focused && deps.sessions.byId(focused)?.load.filePath) || null,
      });
    };

    const cancelPending = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    // ── save ────────────────────────────────────────────────────────────────

    const currentLayout = (): SolidLayout => deps.shellLayout?.read() ?? emptySolidLayout();

    /**
     * The `.ltw` `layout` field for a save: the blob the workspace was opened
     * with, read-modify-written with the current Solid namespace. Keeping the
     * last-loaded blob is what preserves React's keys across a Solid save —
     * without it a Solid save would write `{ solid: … }` and drop them.
     */
    let lastLayoutBlob: unknown = null;

    const saveWorkspace = async (path?: string): Promise<void> => {
      const ws = active();
      if (!ws) return;
      const dest = path ?? ws.filePath;
      const chain = getChain();
      const layout = writeSolidLayout(lastLayoutBlob, currentLayout());
      lastLayoutBlob = layout;
      const common = {
        workspaceId: ws.id,
        workspaceName: ws.name,
        editorTabs: getEditorTabs(),
        layout,
        pipelineChain: chain.chain,
        disabledChainIds: chain.disabledIds,
      };
      if (dest) {
        await saveWorkspaceV4({ ...common, destPath: dest });
        patch(ws.id, { filePath: dest, dirty: false });
      } else {
        const savedPath = await autoSaveWorkspace(common);
        patch(ws.id, { autoSavePath: savedPath, lastAutoSaveAt: Date.now(), dirty: false });
      }
      persistAppState();
      persistMirror();
    };

    const autoSave = async (): Promise<void> => {
      if (restoreDepth > 0) return;
      const ws = active();
      if (!ws || !ws.dirty) return;
      await saveWorkspace().catch((e: unknown) =>
        console.warn('[workspaceStore] auto-save failed:', e),
      );
    };

    const markMutated = (): void => {
      if (restoreDepth > 0) return;
      const id = activeId();
      if (id) patch(id, { dirty: true });
      cancelPending();
      timer = setTimeout(() => {
        timer = null;
        void autoSave();
      }, debounceMs);
    };

    // ── restore ─────────────────────────────────────────────────────────────

    const openPathIds = async (path: string): Promise<string[]> => {
      const before = new Set(deps.sessions.order());
      await deps.actions.openPath(path);
      return deps.sessions.order().filter((id) => !before.has(id));
    };

    const closeAllSessions = async (): Promise<void> => {
      for (const id of [...deps.sessions.order()]) {
        await deps.actions.close(id).catch(() => undefined);
      }
    };

    const applyRestore = async (
      plan: RestorePlan,
      sessionData: readonly LoadWorkspaceSessionData[],
      layout: unknown,
      editorTabs: readonly LtwEditorTab[],
    ): Promise<void> => {
      restoreDepth += 1;
      cancelPending();
      try {
        const outcome = await runRestorePlan(plan, sessionData, { openPath: openPathIds });
        setWarnings(outcome.warnings);
        if (plan.applyLtwViewState) {
          lastLayoutBlob = layout ?? null;
          const solid = readSolidLayout(layout);
          if (solid) deps.shellLayout?.apply(solid);
          // Editor tabs are W9's surface — hand them over rather than
          // inventing a second owner for editor state here.
          setPendingEditorTabs([...editorTabs]);
        }
      } finally {
        restoreDepth -= 1;
        persistMirror();
      }
    };

    const openWorkspace = async (path: string): Promise<void> => {
      const result = await loadWorkspaceV4(path);
      // Explicit open: the `.ltw` is the whole truth — close what is open, then
      // replay the manifest. The mirror does not participate (see restore.ts).
      await closeAllSessions();
      const existing = active();
      const id = existing?.id ?? createEmptyWorkspace().id;
      if (existing) patch(id, { name: result.workspaceName, filePath: path, dirty: false });
      else setList((prev) => [...prev, { id, name: result.workspaceName, filePath: path, dirty: false }]);
      setActiveId(id);
      await applyRestore(planExplicitOpen(result.sessions), result.sessionData, result.layout, result.editorTabs);
      persistAppState();
    };

    const startupRestore = async (): Promise<void> => {
      const ws = active();
      if (!ws) return;
      // A CLI startup file (double-click) wins: that file is what the user
      // asked for, so the `.ltw` auto-restore is skipped entirely — same rule
      // as React's `useStartupRestore`.
      const startupPath = await consumeStartupFile();
      if (disposed) return;
      const mirror = readMirror(storage);
      const { storedTabs, tabPaths } = mirrorToStoredTabs(mirror);
      if (startupPath) {
        await applyRestore(
          planStartupRestore({ sessions: [], storedTabs, tabPaths, hasLocalLayout: true }),
          [], null, [],
        );
        return;
      }
      const candidate = ws.filePath ?? ws.autoSavePath ?? null;
      const result = candidate ? await loadWorkspaceV4(candidate).catch(() => null) : null;
      if (disposed) return;
      await applyRestore(
        planStartupRestore({
          sessions: result?.sessions ?? [],
          storedTabs,
          tabPaths,
          // The mirror standing in for React's localStorage layout: when it
          // holds tabs we already know the strip's shape, so the `.ltw` view
          // state is not replayed over it.
          hasLocalLayout: mirror.tabPaths.length > 0,
        }),
        result?.sessionData ?? [],
        result?.layout ?? null,
        result?.editorTabs ?? [],
      );
    };

    // ── switch / rename / delete ────────────────────────────────────────────

    const switchWorkspace = async (id: string): Promise<void> => {
      if (id === activeId()) return;
      const target = list().find((w) => w.id === id);
      if (!target) return;
      cancelPending();
      // Arms the backend's auto-save switch-suppression before anything is torn
      // down, so a flush in flight cannot write the outgoing workspace's shell
      // into the incoming one.
      await beginWorkspaceSwitch().catch(() => undefined);
      await closeAllSessions();
      setActiveId(id);
      persistAppState();
      const candidate = target.filePath ?? target.autoSavePath ?? null;
      if (!candidate) {
        persistMirror();
        return;
      }
      // A failed load propagates: the target is already active (matching the
      // backend), its sessions are closed, and the caller shows the error —
      // silently landing on an empty workspace hides a missing `.ltw`.
      const result = await loadWorkspaceV4(candidate);
      if (disposed) return;
      await applyRestore(planExplicitOpen(result.sessions), result.sessionData, result.layout, result.editorTabs);
    };

    const newWorkspace = async (): Promise<void> => {
      cancelPending();
      // Same teardown-before-switch bracket as `switchWorkspace`: arm the
      // backend's suppression window before anything closes, so a flush in
      // flight can't write the outgoing workspace's shell into the new one.
      await beginWorkspaceSwitch().catch(() => undefined);
      await closeAllSessions();
      const fresh = createEmptyWorkspace();
      setList((prev) => [...prev, fresh]);
      setActiveId(fresh.id);
      persistAppState();
      persistMirror();
    };

    const rename = async (id: string, name: string): Promise<void> => {
      const entry = await renameWorkspace({ workspaceId: id, newName: name });
      patch(id, { name: entry.name });
    };

    const remove = async (
      id: string,
      options: { deleteFile?: boolean; force?: boolean } = {},
    ): Promise<void> => {
      await deleteWorkspace({
        workspaceId: id,
        deleteFile: options.deleteFile ?? false,
        force: options.force ?? false,
      });
      setList((prev) => prev.filter((w) => w.id !== id));
      // A forced delete of the active workspace leaves the backend with no
      // active id; mirror that rather than promoting an unrelated entry whose
      // `.ltw` was never loaded (an autosave would then write into it).
      if (activeId() === id) setActiveId(null);
    };

    // ── hydration ───────────────────────────────────────────────────────────

    const hydrate = async (): Promise<void> => {
      const disk = await getAppState().catch(() => ({ workspaces: [], activeWorkspaceId: null }));
      if (disposed) return;
      const result = reconcileWorkspaceList(
        { workspaces: [...list()], activeId: activeId() },
        disk,
      );
      if (result.createDefault) {
        const fresh = createEmptyWorkspace();
        setList([fresh]);
        setActiveId(fresh.id);
        persistAppState();
        return;
      }
      setList(result.state.workspaces);
      setActiveId(result.state.activeId);
      if (result.migrated) persistAppState();
    };

    // ── listeners ───────────────────────────────────────────────────────────

    track(
      onWorkspaceListChanged((payload) => {
        if (payload.action === 'deleted') {
          setList((prev) => prev.filter((w) => w.id !== payload.workspaceId));
          if (activeId() === payload.workspaceId) setActiveId(list()[0]?.id ?? null);
          return;
        }
        // A rename can also originate from an agent (the bridge route is open to
        // both callers), so re-read the authoritative list rather than guessing
        // the new name from an event that does not carry it.
        void hydrate();
      }),
    );

    track(
      onWorkspaceAutoSaved((payload) => {
        patch(payload.workspaceId, {
          autoSavePath: payload.path,
          lastAutoSaveAt: payload.savedAt,
          dirty: false,
        });
        persistAppState();
      }),
    );

    // The backend emits one of these per restored session (both the `.ltw` and
    // `.lts` paths). Solid has no chain-restore consumer yet (W4a), so the only
    // thing it means here is "artifacts landed" — refresh the mirror so a crash
    // right after a restore still reopens what is on screen.
    track(onWorkspaceRestored(() => persistMirror()));

    return {
      list,
      activeId,
      active,
      dirty,
      warnings,
      pendingEditorTabs,
      takePendingEditorTabs: () => {
        const tabs = [...pendingEditorTabs()];
        setPendingEditorTabs([]);
        return tabs;
      },
      markMutated,
      hydrate,
      startupRestore,
      openWorkspace,
      saveWorkspace,
      autoSave,
      switchWorkspace,
      newWorkspace,
      rename,
      delete: remove,
      dispose() {
        disposed = true;
        cancelPending();
        for (const un of unlisteners.splice(0)) un();
        disposeRoot();
      },
    };
  });
}
