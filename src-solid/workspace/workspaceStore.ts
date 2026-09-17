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
import { createEffect, createRoot, createSignal, on } from 'solid-js';
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
  syncWorkspaceEnvelope,
} from '@bridge/commands';
import {
  onWorkspaceAutoSaved,
  onWorkspaceListChanged,
  onWorkspaceRestored,
} from '@bridge/events';
import type { LtwEditorTab } from '@bridge/types';
import type { WorkspaceIdentity } from '@bridge/workspaceTypes';
import { createEmptyWorkspace } from '@bridge/workspaceTypes';
import {
  buildAppStatePayload,
  consumeStartupFile,
  normalizePath,
  planExplicitOpen,
  planStartupRestore,
  reconcileWorkspaceList,
} from '@workspace';
import type { RestorePlan, StoredTab } from '@workspace';
import type { LoadWorkspaceSessionData } from '@bridge/types';
// Region widths and the collapsed-column set are keyed per workspace in
// localStorage by `shell/Splitter` and `shell/regionCollapse`; deleting a
// workspace has to take both entries with it, and the key shapes are the
// shell's to own — hence the barrel import rather than a second copy of the
// prefixes here. `shell` only reaches back into `workspace/layoutBlob` (a
// leaf), so this adds no module cycle.
import { collapsedStorageKey, widthsStorageKey } from '../shell';
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
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /**
   * Last-resort confirm before a workspace transition discards state that the
   * flush could not persist (see `flushForTransition`). Defaults to the
   * platform `confirm`; injected in tests. Same injected-confirm shape
   * `editorStore` already uses for a dirty document.
   */
  confirmDiscard?: (message: string) => boolean;
  autoSaveDebounceMs?: number;
}

export interface WorkspaceStore {
  list: Accessor<readonly WorkspaceIdentity[]>;
  activeId: Accessor<string | null>;
  active: Accessor<WorkspaceIdentity | null>;
  dirty: Accessor<boolean>;
  /** Warnings from the most recent restore — every session the `.ltw` named
   *  that could not be reopened (the file was deleted, or its drive is gone)
   *  or whose artifacts failed to land. Workspace home renders them; they
   *  stay until the user dismisses them or the next restore replaces them. */
  warnings: Accessor<readonly string[]>;
  /** Dismiss the restore warnings. */
  clearWarnings(): void;
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

function readMirror(storage: Pick<Storage, 'getItem'>): WorkspaceMirror {
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

function writeMirror(storage: Pick<Storage, 'setItem'>, mirror: WorkspaceMirror): void {
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
    const confirmDiscard = deps.confirmDiscard ?? ((message: string): boolean => globalThis.confirm(message));

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

    /** Drop the shell's per-workspace region state for a workspace that no
     *  longer exists. `logtapper-shell-widths:<id>` and
     *  `logtapper-shell-collapsed:<id>` have no other owner and no expiry, so
     *  without this localStorage accretes a dead entry per delete. */
    const forgetShellRegionState = (id: string): void => {
      try {
        storage.removeItem(widthsStorageKey(id));
        storage.removeItem(collapsedStorageKey(id));
      } catch {
        /* private mode / quota — the region caches are best-effort by design. */
      }
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

    /**
     * Refresh the backend's cached `WorkspaceEnvelope` — a bare
     * `sync_workspace_envelope` call, no file write. Backend-owned mutations
     * (chain commits, bookmarks, analyses — `services::chain::commit` and
     * friends) debounce-flush through that cache (`autosave.rs::flush`), which
     * skips with "no workspace envelope cached yet" until something calls
     * `cache_envelope`. This store previously only reached `cache_envelope`
     * via an explicit `saveWorkspace()` — armed by `autoSave()`, which only
     * fires once the workspace is `dirty` — so a workspace that was opened,
     * restored, or switched into but never explicitly saved left the backend
     * uncached: the first agent-driven chain/bookmark edit had nothing to
     * flush and was lost on restart. React avoids this by pushing an envelope
     * right after every open/restore/switch (`pushWorkspaceEnvelope` in
     * `useWorkspace.ts` / `useStartupRestore.ts`); this mirrors that.
     *
     * Builds the same field set `saveWorkspace`'s `common` payload builds,
     * including read-modify-writing `lastLayoutBlob` the same way, so a later
     * real save merges from the same baseline this push reported rather than
     * from a stale one.
     *
     * No-op with no active workspace, or while a restore/switch/teardown is
     * in flight (`restoreDepth > 0`): the backend's switch-suppression window
     * exists precisely to stop a flush from observing a mid-teardown session
     * set, and a push here would only race that guard for no benefit — every
     * call site below fires after its restore/teardown has already settled.
     */
    const pushEnvelope = (): void => {
      if (restoreDepth > 0) return;
      const ws = active();
      if (!ws) return;
      const chain = getChain();
      const layout = writeSolidLayout(lastLayoutBlob, currentLayout());
      lastLayoutBlob = layout;
      void syncWorkspaceEnvelope({
        workspaceId: ws.id,
        workspaceName: ws.name,
        ltwPath: ws.filePath,
        editorTabs: getEditorTabs(),
        layout,
        pipelineChain: chain.chain,
        disabledChainIds: chain.disabledIds,
      }).catch((e: unknown) => console.warn('[workspaceStore] Failed to sync workspace envelope:', e));
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

    /**
     * The durability gate every transition (switch / open / new) runs first.
     *
     * Flushing the armed debounce *before* the teardown is the guarantee React
     * relies on instead of a "save changes?" prompt — `useWorkspace.ts`'s
     * `runTransition` runs `await doAutoSave()` before `doClearPanes()` and
     * calls that ordering load-bearing. Cancelling the timer first (what this
     * store used to do) threw the outgoing workspace's frontend-owned state —
     * the Solid layout blob and the editor tabs nothing else writes — away.
     *
     * Only when the workspace is *still* dirty afterwards (the save threw, or
     * there was no workspace to save into) is anything actually at risk, and
     * that is the one case worth a prompt. Returns false when the user
     * cancelled, which aborts the transition.
     */
    const flushForTransition = async (): Promise<boolean> => {
      await autoSave();
      cancelPending();
      const ws = active();
      if (!ws?.dirty) return true;
      return confirmDiscard(
        `"${ws.name}" has unsaved changes that could not be saved. Discard them?`,
      );
    };

    // ── restore ─────────────────────────────────────────────────────────────

    const openPathIds = async (path: string): Promise<string[]> => {
      const before = new Set(deps.sessions.order());
      await deps.actions.openPath(path);
      return deps.sessions.order().filter((id) => !before.has(id));
    };

    const closeAllSessions = async (): Promise<void> => {
      // Teardown is not a mutation of the workspace being torn down: bracket
      // it like a restore so the membership effect below stays quiet, or the
      // outgoing workspace would be flagged dirty on every switch.
      restoreDepth += 1;
      try {
        for (const id of [...deps.sessions.order()]) {
          await deps.actions.close(id).catch(() => undefined);
        }
      } finally {
        restoreDepth -= 1;
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
        // Remember the loaded blob on EVERY restore, not only when its view
        // state is applied: a startup restore that trusts the local mirror
        // skips the apply, and a later save must still read-modify-write the
        // file's blob or React's keys are dropped (phase 2b smoke finding).
        if (layout !== undefined) lastLayoutBlob = layout ?? null;
        if (plan.applyLtwViewState) {
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
      if (!(await flushForTransition())) return;
      const result = await loadWorkspaceV4(path);
      // Explicit open: the `.ltw` is the whole truth — close what is open, then
      // replay the manifest. The mirror does not participate (see restore.ts).
      await closeAllSessions();
      // The opened `.ltw` gets its OWN list entry (React's `addWorkspaceEntry`),
      // never the active entry re-pointed at it: that re-point dropped the
      // previously active workspace from the list while leaving its
      // `autoSavePath`/`lastAutoSaveAt` attached to the newly opened file.
      // Keying the entry on the manifest's own workspace id (rather than a
      // fresh uuid as React does) makes reopening the same `.ltw` idempotent
      // instead of growing a duplicate entry each time; a legacy file with no
      // id still gets a fresh one.
      const id = result.workspaceId ?? createEmptyWorkspace().id;
      const known = list().some((w) => w.id === id);
      if (known) patch(id, { name: result.workspaceName, filePath: path, dirty: false });
      else {
        setList((prev) => [
          ...prev,
          {
            id,
            name: result.workspaceName,
            filePath: path,
            dirty: false,
            autoSavePath: null,
            lastAutoSaveAt: null,
          },
        ]);
      }
      setActiveId(id);
      await applyRestore(planExplicitOpen(result.sessions), result.sessionData, result.layout, result.editorTabs);
      pushEnvelope();
      persistAppState();
    };

    /**
     * Read a workspace's `.ltw` purely for its layout blob, replaying nothing.
     * `undefined` when there is no candidate or the read failed — the value
     * `applyRestore` treats as "leave the remembered blob alone".
     */
    const loadBlobOnly = async (ws: WorkspaceIdentity): Promise<unknown> => {
      const candidate = ws.filePath ?? ws.autoSavePath ?? null;
      if (!candidate) return undefined;
      const result = await loadWorkspaceV4(candidate).catch(() => null);
      return result ? result.layout : undefined;
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
        // `consumeStartupFile()` `.take()`s the backend value once per process,
        // so this is the only chance to act on it: the file the user
        // double-clicked has to be *opened*, not merely used as the reason to
        // skip the `.ltw` restore. React does this in `useStartupFile`; Solid
        // has no second consumer, so the path is prepended to the mirror's
        // loads here (first, so it lands as the leading tab).
        const plan = planStartupRestore({ sessions: [], storedTabs, tabPaths, hasLocalLayout: true });
        const loads = plan.loads.some((l) => normalizePath(l.path) === normalizePath(startupPath))
          ? plan.loads
          : [{ path: startupPath, dataIndex: null }, ...plan.loads];
        // The `.ltw` manifest is deliberately not replayed — but its layout
        // blob still has to be read, or the first save after a double-click
        // start writes `{ solid: … }` alone and strips React's keys from the
        // file. A failed read passes `undefined`, which leaves the remembered
        // blob alone rather than nulling it.
        const blobSource = await loadBlobOnly(ws);
        if (disposed) return;
        await applyRestore({ ...plan, loads }, [], blobSource, []);
        pushEnvelope();
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
      pushEnvelope();
    };

    // ── switch / rename / delete ────────────────────────────────────────────

    const switchWorkspace = async (id: string): Promise<void> => {
      if (id === activeId()) return;
      const target = list().find((w) => w.id === id);
      if (!target) return;
      // Flush the outgoing workspace BEFORE the suppression window and the
      // teardown — see `flushForTransition`.
      if (!(await flushForTransition())) return;
      // Arms the backend's auto-save switch-suppression before anything is torn
      // down, so a flush in flight cannot write the outgoing workspace's shell
      // into the incoming one.
      await beginWorkspaceSwitch().catch(() => undefined);
      await closeAllSessions();
      setActiveId(id);
      persistAppState();
      const candidate = target.filePath ?? target.autoSavePath ?? null;
      if (!candidate) {
        // Nothing to load, so `applyRestore` never runs: drop the outgoing
        // workspace's blob by hand or the next save would write its React
        // layout keys into this one's `.ltw`.
        lastLayoutBlob = null;
        persistMirror();
        // The target is active now (never saved before, so no `.ltw`/auto-save
        // path) — cache its envelope so a backend-owned mutation has something
        // to flush before this frontend ever calls `saveWorkspace` itself.
        pushEnvelope();
        return;
      }
      // A failed load propagates: the target is already active (matching the
      // backend), its sessions are closed, and the caller shows the error —
      // silently landing on an empty workspace hides a missing `.ltw`.
      const result = await loadWorkspaceV4(candidate);
      if (disposed) return;
      await applyRestore(planExplicitOpen(result.sessions), result.sessionData, result.layout, result.editorTabs);
      pushEnvelope();
    };

    /**
     * Install a fresh, unsaved workspace as the active one: list, active id,
     * app-state, mirror, and the backend envelope. The one definition of what
     * "a new workspace" means — `newWorkspace` (after its teardown) and the
     * orphan-session adoption paths share it, so the sequence cannot drift.
     *
     * A fresh workspace loads no `.ltw`, so nothing else clears the layout
     * blob the previous workspace was opened with — the first autosave would
     * otherwise stamp that workspace's React pane tree and tab selections into
     * this one's file. And it has no `.ltw`/auto-save path yet, so the backend
     * envelope is pushed here: the first backend-owned mutation (an agent
     * adding a bookmark before the user ever saves) then has something to
     * flush.
     */
    const installFreshWorkspace = (): void => {
      const fresh = createEmptyWorkspace();
      setList((prev) => [...prev, fresh]);
      setActiveId(fresh.id);
      lastLayoutBlob = null;
      persistAppState();
      persistMirror();
      pushEnvelope();
    };

    const newWorkspace = async (): Promise<void> => {
      if (!(await flushForTransition())) return;
      // Same teardown-before-switch bracket as `switchWorkspace`: arm the
      // backend's suppression window before anything closes, so a flush in
      // flight can't write the outgoing workspace's shell into the new one.
      await beginWorkspaceSwitch().catch(() => undefined);
      await closeAllSessions();
      installFreshWorkspace();
    };

    /**
     * Give sessions that have no workspace a fresh default one and make it
     * active — `installFreshWorkspace` without any teardown, because the whole
     * point is to keep what is open. Callers decide whether a session is
     * actually orphaned; this only creates the home.
     */
    const adoptOrphanSessions = installFreshWorkspace;

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
      // The shell's per-workspace region widths outlive the workspace itself
      // otherwise — `logtapper-shell-widths:<id>` has no other owner and no
      // expiry, so localStorage accretes a dead entry per deleted workspace.
      forgetShellRegionState(id);
      // A forced delete of the active workspace leaves the backend with no
      // active id; mirror that rather than promoting an unrelated entry whose
      // `.ltw` was never loaded (an autosave would then write into it).
      if (activeId() === id) {
        setActiveId(null);
        lastLayoutBlob = null;
        // The sessions that were open in the deleted workspace are still open;
        // leaving them with no workspace is the orphan case the membership
        // effect guards against, so give them a home right away.
        if (deps.sessions.order().length > 0) {
          adoptOrphanSessions();
          markMutated();
        }
      }
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
        // A session opened before this hydrate settled (a CLI startup file) may
        // already have adopted a fresh workspace; replacing the list here would
        // orphan it again.
        if (activeId() !== null && list().some((w) => w.id === activeId())) {
          persistAppState();
          return;
        }
        const fresh = createEmptyWorkspace();
        setList([fresh]);
        setActiveId(fresh.id);
        persistAppState();
        return;
      }
      setList(result.state.workspaces);
      // `reconcileWorkspaceList` makes disk authoritative for `activeId`, which
      // is right at startup — but `hydrate()` also runs from the
      // `workspace-list-changed` listener, where adopting disk's id would move
      // this window "into" another workspace with no teardown, no layout apply
      // and no blob reset, and the next autosave would write these sessions
      // into that workspace's `.ltw`. Keep the in-memory id whenever it
      // survived the reconcile; only a vanished one follows disk.
      const current = activeId();
      const keepCurrent = current !== null && result.state.workspaces.some((w) => w.id === current);
      setActiveId(keepCurrent ? current : result.state.activeId);
      if (result.migrated) persistAppState();
    };

    // ── session membership ──────────────────────────────────────────────────
    // The `.ltw` manifest is the list of open files, so opening or closing a
    // session is workspace content and must autosave like a bookmark does —
    // whichever caller did it (the user's dialog, an agent's `open_file`, a
    // `session-closed` echo). Watched here rather than wired into each opener
    // so no path can forget. `markMutated` already ignores a restore in flight.
    //
    // A session that opens while NO workspace is active (app-state whose active
    // id is null — a forced delete of the active workspace leaves it that way,
    // and so does a first launch whose hydrate lost the race with a CLI file)
    // would otherwise belong to nothing: no autosave tracks it, and the next
    // "New workspace" tears every session down before creating the empty one,
    // so the file the user just opened is simply gone. Adopt it into a fresh
    // default workspace first, exactly as if the user had clicked New
    // workspace before opening the file.
    createEffect(
      on(
        () => deps.sessions.order().join('\n'),
        (ids, prev) => {
          if (ids === prev) return;
          if (activeId() === null && restoreDepth === 0 && deps.sessions.order().length > 0) {
            adoptOrphanSessions();
          }
          markMutated();
        },
        { defer: true },
      ),
    );

    // ── listeners ───────────────────────────────────────────────────────────

    track(
      onWorkspaceListChanged((payload) => {
        if (payload.action === 'deleted') {
          setList((prev) => prev.filter((w) => w.id !== payload.workspaceId));
          forgetShellRegionState(payload.workspaceId);
          if (activeId() === payload.workspaceId) {
            setActiveId(list()[0]?.id ?? null);
            // Promoting a neighbour loads no `.ltw`, so the blob of the deleted
            // workspace must not survive into the promoted one's next save.
            lastLayoutBlob = null;
          }
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
      clearWarnings: () => setWarnings([]),
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
