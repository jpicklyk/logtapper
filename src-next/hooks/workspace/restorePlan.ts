/**
 * Pure, React-free planner for workspace restore (design:
 * `plans/workspace-restore-design.md` §Q2, design 2A).
 *
 * A restore has to reconcile two sources of truth about which sessions belong to
 * a workspace:
 *
 * 1. The `.ltw` **manifest** — the durable record written on save/flush. Carries
 *    per-session artifacts (bookmarks, analyses, pipeline meta).
 * 2. The **localStorage tabs** — the fast bootstrap mirror the app has always
 *    replayed at startup. Fresher than the manifest for anything opened since the
 *    last flush, but carries no artifacts.
 *
 * This module folds both into a single ordered list of `loadFile` calls plus a
 * decision on whether the `.ltw` view-state blob should be replayed. It is the
 * one place the union/dedup rules live, so they are finally unit-testable
 * (previously the localStorage half lived inline in `useFileSession.ts:264-303`).
 *
 * The caller (`useStartupRestore` / `doLoadWorkspace`) does all IPC and
 * localStorage reads and hands this function plain data.
 */
import type { LtwManifestSession, LoadWorkspaceSessionData } from '../../bridge/types';
import type { SessionLoadOutcome } from './artifactPairing';

/** One `loadFile(path, paneId?, existingTabId?)` the core will perform. */
export interface RestoreLoad {
  /** Absolute source path passed to `loadFile`. */
  path: string;
  /** Pane the session should load into. Undefined → `loadFile` picks the active
   *  / first pane (the explicit-open and fresh-manifest-entry case). */
  paneId?: string;
  /** Persisted tab id so `loadFile` binds the session to the tab already present
   *  in the localStorage-restored tree (post-P0-c this also gives the load its
   *  own destination-keyed generation, so sibling-tab restores don't cancel each
   *  other). Undefined → a fresh tab is created. */
  existingTabId?: string;
  /** Index into `sessionData` whose artifacts this load's session should receive,
   *  or `null` when the load carries no manifest artifacts (a localStorage tab
   *  opened after the last flush — union semantics). */
  dataIndex: number | null;
}

export interface RestorePlan {
  loads: RestoreLoad[];
  /** Replay the `.ltw` editor-tab events + layout blob. True only when
   *  localStorage layout is absent (a hard crash lost it) — otherwise
   *  localStorage is fresher and replaying `.ltw` editor tabs would duplicate
   *  tabs that self-restore from their own localStorage keys. Always true for an
   *  explicit user open (no localStorage tabs claimed). */
  applyLtwViewState: boolean;
  /** Human-readable notes about divergences (missing/extra/deduped entries).
   *  Surfaced to the user in the restore notice, not just `console.warn`. */
  warnings: string[];
}

/** A persisted logviewer tab (from `getStoredLogviewerTabs`). */
export interface StoredTab {
  tabId: string;
  paneId: string;
  isActive: boolean;
}

export interface PlanInput {
  /** `.ltw` manifest sessions (empty for the pure-localStorage plan). The
   *  parallel `sessionData` is NOT needed here — the plan emits `dataIndex` and
   *  the core resolves it against its own `sessionData`, which decouples the pure
   *  planner from the artifact payload. */
  sessions: LtwManifestSession[];
  /** Persisted logviewer tabs across all panes. */
  storedTabs: StoredTab[];
  /** `logtapper_tab_paths`: tabId → source path. */
  tabPaths: Record<string, string>;
  /** Whether localStorage holds a layout blob (drives `applyLtwViewState`). */
  hasLocalLayout: boolean;
}

/** Whether `path` is a `.lts` (LogTapper session archive) file. Case-insensitive. */
export function isLts(path: string): boolean {
  return path.toLowerCase().endsWith('.lts');
}

/**
 * Core planner shared by both entry points. `applyLtwViewState` is supplied by
 * the caller so the explicit-open path can force it true while startup gates it
 * on `hasLocalLayout`.
 */
function planRestore(input: PlanInput, applyLtwViewState: boolean): RestorePlan {
  const { sessions, storedTabs, tabPaths } = input;
  const warnings: string[] = [];
  const claimed = new Set<string>();
  // Raw-path dedup for `.lts`: a multi-session `.lts` recreates all its embedded
  // sessions from one load, so every later reference to the same `.lts` (whether
  // another manifest entry or a sibling stored tab) must be skipped — otherwise
  // it would spawn N×M backend sessions. Folded here from useFileSession.ts.
  const handledLtsPaths = new Set<string>();

  interface InternalLoad extends RestoreLoad { isActive: boolean }
  const loads: InternalLoad[] = [];

  const ltsAlreadyHandled = (path: string): boolean => {
    if (!isLts(path)) return false;
    if (handledLtsPaths.has(path)) return true;
    handledLtsPaths.add(path);
    return false;
  };

  // 1. Manifest entries — each matched to the first unclaimed stored tab that
  //    points at the same path (so it reloads into its persisted tab slot);
  //    unmatched entries load as fresh tabs.
  for (let i = 0; i < sessions.length; i++) {
    const path = sessions[i].filePath;
    const tab = storedTabs.find((t) => !claimed.has(t.tabId) && tabPaths[t.tabId] === path);
    if (tab) claimed.add(tab.tabId);

    if (ltsAlreadyHandled(path)) {
      // Its embedded sessions were already recreated by the first reference; this
      // entry's artifacts come from the `.lts`'s own stored data, not here.
      warnings.push(`Skipped duplicate .lts reference "${path}" — its sessions load once.`);
      continue;
    }

    loads.push({
      path,
      paneId: tab?.paneId,
      existingTabId: tab?.tabId,
      dataIndex: i,
      isActive: tab?.isActive ?? false,
    });
  }

  // 2. Stored tabs the manifest did not account for — the file was opened after
  //    the last flush. Load them too (union: bias toward not losing anything),
  //    but with no manifest artifacts. Unsaved stream tabs (no path) are skipped.
  for (const tab of storedTabs) {
    if (claimed.has(tab.tabId)) continue;
    const path = tabPaths[tab.tabId];
    if (!path) continue;
    if (ltsAlreadyHandled(path)) continue;
    if (sessions.length > 0) {
      warnings.push(`"${path}" is open but not in the workspace file — restored as an extra tab.`);
    }
    loads.push({
      path,
      paneId: tab.paneId,
      existingTabId: tab.tabId,
      dataIndex: null,
      isActive: tab.isActive,
    });
  }

  // 3. Active tabs first so each pane's active tab establishes the pane's session
  //    (the first load into a pane replaces its empty tab; later loads open as
  //    new tabs). Stable sort preserves manifest/insertion order within a group.
  loads.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0));

  return {
    loads: loads.map(({ isActive: _isActive, ...load }) => load),
    applyLtwViewState,
    warnings,
  };
}

/**
 * Explicit user open (double-click / File → Open Workspace). No localStorage tabs
 * participate — the `.ltw` is the whole truth and its view-state is always
 * applied, exactly as `doLoadWorkspace` did before extraction.
 */
export function planExplicitOpen(sessions: LtwManifestSession[]): RestorePlan {
  return planRestore(
    { sessions, storedTabs: [], tabPaths: {}, hasLocalLayout: false },
    /* applyLtwViewState */ true,
  );
}

/**
 * Startup restore. Unions the trusted `.ltw` manifest (may be empty for the
 * pure-localStorage fallback) with the localStorage tabs. The `.ltw` view-state
 * is replayed only when localStorage lost its layout.
 */
export function planStartupRestore(input: PlanInput): RestorePlan {
  return planRestore(input, /* applyLtwViewState */ !input.hasLocalLayout);
}

/**
 * Pair each load with the sessions its *own* `loadFile` produced (via the
 * `session:loaded` slice), so a load that failed or was deduped drops its own
 * artifacts rather than shifting every later entry. Pure — kept here (not in the
 * DOM-touching core) so it is unit-testable in a plain environment.
 */
export function buildRestoreOutcomes(
  loads: RestoreLoad[],
  producedSessionIdsPerLoad: string[][],
  sessionData: LoadWorkspaceSessionData[],
): Array<SessionLoadOutcome<LoadWorkspaceSessionData>> {
  return loads.map((load, i) => ({
    filePath: load.path,
    producedSessionIds: producedSessionIdsPerLoad[i] ?? [],
    data: load.dataIndex != null ? sessionData[load.dataIndex] : undefined,
  }));
}
