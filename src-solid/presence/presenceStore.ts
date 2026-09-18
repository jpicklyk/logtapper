/**
 * The one presence store per app: bridge status, the shared activity journal,
 * the shared focus context, and the queue of agent navigation requests.
 *
 * Everything the presence surfaces need is fetched and subscribed exactly once
 * here, so `PresencePanel` and `ActivityFeed` are pure renderers over
 * accessors. It also owns the single `createAgentState()` controller (A1) and
 * drives its `feed()`/`setPending()` inputs — the orb never subscribes to
 * anything itself.
 *
 * Lifetime: the store owns a `createRoot`, so it may be built outside a
 * component body (same pattern as `theme/applyTheme.ts` and A1's
 * `createAgentState`). Every Tauri listener registered here is unlistened by
 * `dispose()`, including ones whose `listen()` promise resolves after dispose
 * (the StrictMode-safe pattern from the React `CLAUDE.md` — the concern is real
 * in Solid too: a test or a re-created store disposes before the promise
 * settles).
 */
import { batch, createMemo, createRoot, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  getActivity,
  getExportAllSessionsInfo,
  getFocus,
  getMcpStatus,
  setFocus,
} from '@bridge/commands';
import { onActivity, onAgentRequest, onFocusChanged, onNavigateRequest } from '@bridge/events';
import type { ActivityEntry, FocusContext, McpStatus, NavRequest } from '@bridge/types';
import { createAgentState } from './agentState';
import type { AgentStateController } from './agentState';

/**
 * Journal cap. The backend ring holds 500; keeping the same number here means
 * the panel shows everything the backend still remembers and never has to
 * reconcile a gap.
 */
export const MAX_JOURNAL_ENTRIES = 500;

/** Bridge-status poll interval. Slow on purpose — every event also forces a refresh. */
export const STATUS_POLL_MS = 5_000;

/**
 * Trailing debounce on the event-driven status/name refreshes. A busy agent
 * emits one `onActivity` per tool call; without this each one costs a
 * `get_mcp_status` (plus a `get_export_all_sessions_info` for `session.*`) IPC
 * round trip, turning the journal into an IPC amplifier. The 5 s poll already
 * bounds how stale the status can get, so collapsing a burst into one refresh
 * loses nothing.
 */
export const STATUS_REFRESH_DEBOUNCE_MS = 250;

/** `true` = an agent's navigation request waits for Apply; `false` = it jumps immediately. */
export const NAV_CONFIRM_STORAGE_KEY = 'logtapper-presence-nav-confirm';

/** Where a feed entry or a navigation request points. Unknown targets carry only `sessionId`. */
export interface NavTarget {
  sessionId: string;
  line?: number;
  analysisId?: string;
  watchId?: string;
  bookmarkId?: string;
}

/** How a queued navigation request was resolved. */
export type NavResolution = 'applied' | 'held' | 'dismissed';

export interface PresenceStoreOptions {
  /** Called when a navigation target should actually be shown. */
  navigate?: (target: NavTarget) => void;
  /** Poll interval override (tests). */
  pollMs?: number;
  /** Event-driven refresh debounce override (tests). */
  refreshDebounceMs?: number;
  /** Journal page size / cap override (tests). */
  limit?: number;
}

export interface PresenceStore {
  status: Accessor<McpStatus | null>;
  /**
   * Force an immediate `get_mcp_status` re-read. Undebounced: the caller is a
   * user-initiated write that needs the backend's answer to *that* write
   * (`settingsStore.setAgentRawAccess` / `setMcpBridgeEnabled`), not the ≤5 s
   * poll's last one. The backend stays the only writer of `status`.
   */
  refreshStatus: () => void;
  /** The raw-access checkbox alone (Settings → General). */
  agentRawAccess: Accessor<boolean>;
  /**
   * Whether agents actually read raw text right now: the backend's
   * `McpStatus.effectiveAgentRaw` (raw access on, OR the anonymizer mode is
   * `None`), computed there so the presence warning, the orb's `raw` state,
   * the anonymizer card and Settings all agree. Never recomputed here.
   */
  effectiveAgentRaw: Accessor<boolean>;
  /** Journaled actions, oldest first, deduped by id and capped. */
  entries: Accessor<readonly ActivityEntry[]>;
  focus: Accessor<FocusContext | null>;
  /** Requests awaiting a decision, oldest first. Always empty while confirmation is off. */
  pendingNav: Accessor<readonly NavRequest[]>;
  requireNavConfirmation: Accessor<boolean>;
  setRequireNavConfirmation: (value: boolean) => void;
  /** `sessionId` → display name, or the id itself when the session is unknown. */
  sessionName: (sessionId: string) => string;
  /** The agent orb's derived state (A1). */
  agent: AgentStateController;
  /** Apply a queued request: navigate, then drop it. */
  applyNav: (id: number) => void;
  /** Keep the request listed but stop it counting as "needs you". */
  holdNav: (id: number) => void;
  /** Whether a still-listed request has been held. */
  isNavHeld: (id: number) => boolean;
  /** Drop a queued request without navigating. */
  dismissNav: (id: number) => void;
  /** Navigate to an arbitrary target (a feed-entry click). */
  navigate: (target: NavTarget) => void;
  /** Clear the shared focus context. */
  clearFocus: () => Promise<void>;
  dispose: () => void;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
  } catch {
    return fallback;
  }
}

function writeStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private mode / blocked storage: the toggle still works for this session.
  }
}

/** Merge new entries into the journal: dedupe by id, keep ascending order, cap the tail. */
export function mergeEntries(
  previous: readonly ActivityEntry[],
  incoming: readonly ActivityEntry[],
  cap: number,
): readonly ActivityEntry[] {
  const seen = new Set(previous.map((e) => e.id));
  const added = incoming.filter((e) => !seen.has(e.id));
  if (added.length === 0) return previous;
  const next = [...previous, ...added].sort((a, b) => a.id - b.id);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function createPresenceStore(options: PresenceStoreOptions = {}): PresenceStore {
  return createRoot((disposeRoot) => {
    const cap = options.limit ?? MAX_JOURNAL_ENTRIES;
    const pollMs = options.pollMs ?? STATUS_POLL_MS;
    const refreshDebounceMs = options.refreshDebounceMs ?? STATUS_REFRESH_DEBOUNCE_MS;

    const [status, setStatus] = createSignal<McpStatus | null>(null);
    const [entries, setEntries] = createSignal<readonly ActivityEntry[]>([]);
    const [focus, setFocusSignal] = createSignal<FocusContext | null>(null);
    const [pendingNav, setPendingNav] = createSignal<readonly NavRequest[]>([]);
    // Held request ids — see `resolve`. A signal, not a Set, so cards re-render.
    const [heldIds, setHeldIds] = createSignal<readonly number[]>([]);
    const [names, setNames] = createSignal<Readonly<Record<string, string>>>({});
    const [requireNavConfirmation, setRequireConfirmSignal] = createSignal(
      readStoredBoolean(NAV_CONFIRM_STORAGE_KEY, true),
    );

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    /** Register a listener so dispose() always wins the race with its promise. */
    const track = (pending: Promise<UnlistenFn>): void => {
      void pending
        .then((fn) => {
          if (disposed) fn();
          else unlisteners.push(fn);
        })
        .catch(() => {
          // No Tauri host (tests, browser preview): the surface degrades to
          // whatever the initial fetches returned.
        });
    };

    const agentRawAccess = createMemo(() => status()?.agentRawAccess ?? false);
    const effectiveAgentRaw = createMemo(() => status()?.effectiveAgentRaw ?? false);

    // The orb goes `raw` whenever agents read raw text, whichever of the two
    // gates opened it.
    const agent = createAgentState({
      bridgeStatus: status,
      agentRawAccess: effectiveAgentRaw,
      activity: entries,
    });

    // ── Bridge status ────────────────────────────────────────────────────
    const refreshStatus = (): void => {
      void getMcpStatus()
        .then((next) => {
          if (!disposed) setStatus(next);
        })
        .catch(() => {
          // A status read failing is itself "detached" — leave the last value.
        });
    };
    refreshStatus();
    const pollTimer = setInterval(refreshStatus, pollMs);

    // ── Session names ────────────────────────────────────────────────────
    const refreshSessionNames = (): void => {
      void getExportAllSessionsInfo()
        .then((info) => {
          if (disposed) return;
          const next: Record<string, string> = {};
          for (const entry of info.sessions) next[entry.sessionId] = entry.sourceFilename;
          setNames(next);
        })
        .catch(() => {
          // Names are a nicety; the feed falls back to session ids.
        });
    };
    refreshSessionNames();

    const sessionName = (sessionId: string): string => names()[sessionId] ?? sessionId;

    // ── Debounced event-driven refresh ───────────────────────────────────
    // One timer for both fetches: a burst of agent activity collapses into a
    // single trailing refresh (see STATUS_REFRESH_DEBOUNCE_MS).
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshNamesToo = false;
    const scheduleEventRefresh = (alsoNames: boolean): void => {
      refreshNamesToo ||= alsoNames;
      if (refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        const withNames = refreshNamesToo;
        refreshNamesToo = false;
        if (disposed) return;
        if (withNames) refreshSessionNames();
        refreshStatus();
      }, refreshDebounceMs);
    };

    // ── Activity journal ─────────────────────────────────────────────────
    const ingest = (incoming: readonly ActivityEntry[]): void => {
      setEntries((previous) => mergeEntries(previous, incoming, cap));
    };

    track(
      onActivity((entry) => {
        if (disposed) return;
        ingest([entry]);
        // A session opening or closing changes the name map; the bridge status
        // (session count, raw access) can change with any journaled mutation.
        // Debounced — a tool-calling agent emits these far faster than either
        // fetch is worth repeating.
        scheduleEventRefresh(entry.action.startsWith('session.'));
      }),
    );

    void getActivity(cap)
      .then((list) => {
        if (!disposed) ingest(list);
      })
      .catch(() => {
        // The journal is a nicety; a failed read must not blank the panel.
      });

    // ── Request lifecycle ────────────────────────────────────────────────
    // The only signal that an agent is *reading* — reads never reach the
    // journal. Fed straight to the orb; nothing here is stored or refreshed
    // (a request is not a mutation, and the 5 s poll covers the status).
    track(
      onAgentRequest((event) => {
        if (!disposed) agent.request(event);
      }),
    );

    // ── Shared focus ─────────────────────────────────────────────────────
    track(
      onFocusChanged((next) => {
        if (!disposed) setFocusSignal(next);
      }),
    );

    void getFocus()
      .then((next) => {
        if (!disposed) setFocusSignal(next);
      })
      .catch(() => {
        // No focus shared yet, or no host.
      });

    const clearFocus = async (): Promise<void> => {
      setFocusSignal(null); // optimistic; `focus-changed` confirms
      await setFocus(null).catch(() => undefined);
    };

    // ── Navigation requests ──────────────────────────────────────────────
    const navigate = (target: NavTarget): void => {
      options.navigate?.(target);
    };

    /**
     * The orb shows `needs` only for requests the user has not yet acknowledged.
     * A held request stays listed (so it can still be applied later) but stops
     * demanding attention, so "held" is tracked separately from the queue.
     */
    const syncPendingFlag = (queue: readonly NavRequest[]): void => {
      const heldNow = heldIds();
      agent.setPending(queue.some((r) => !heldNow.includes(r.id)));
    };

    const resolve = (id: number, how: NavResolution): void => {
      const request = pendingNav().find((r) => r.id === id);
      if (!request) return;
      if (how === 'held') {
        setHeldIds((current) => (current.includes(id) ? current : [...current, id]));
        syncPendingFlag(pendingNav());
        return;
      }
      setHeldIds((current) => current.filter((held) => held !== id));
      const next = pendingNav().filter((r) => r.id !== id);
      batch(() => {
        setPendingNav(next);
        syncPendingFlag(next);
      });
      if (how === 'applied') {
        navigate({
          sessionId: request.sessionId,
          ...(request.line !== null ? { line: request.line } : {}),
          ...(request.analysisId !== null ? { analysisId: request.analysisId } : {}),
        });
      }
    };

    track(
      onNavigateRequest((request) => {
        if (disposed) return;
        if (!requireNavConfirmation()) {
          navigate({
            sessionId: request.sessionId,
            ...(request.line !== null ? { line: request.line } : {}),
            ...(request.analysisId !== null ? { analysisId: request.analysisId } : {}),
          });
          return;
        }
        const next = [...pendingNav(), request];
        batch(() => {
          setPendingNav(next);
          syncPendingFlag(next);
        });
      }),
    );

    const setRequireNavConfirmation = (value: boolean): void => {
      setRequireConfirmSignal(value);
      writeStoredBoolean(NAV_CONFIRM_STORAGE_KEY, value);
      if (!value) {
        // Turning confirmation off applies whatever is already waiting, so the
        // queue can never outlive the setting that created it.
        const queued = pendingNav();
        batch(() => {
          setHeldIds([]);
          setPendingNav([]);
          agent.setPending(false);
        });
        for (const request of queued) {
          navigate({
            sessionId: request.sessionId,
            ...(request.line !== null ? { line: request.line } : {}),
            ...(request.analysisId !== null ? { analysisId: request.analysisId } : {}),
          });
        }
      }
    };

    const dispose = (): void => {
      if (disposed) return; // idempotent: a double call must not re-run agent.dispose()/disposeRoot()
      disposed = true;
      clearInterval(pollTimer);
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      for (const fn of unlisteners) fn();
      unlisteners.length = 0;
      agent.dispose();
      disposeRoot();
    };

    return {
      status,
      refreshStatus,
      agentRawAccess,
      effectiveAgentRaw,
      entries,
      focus,
      pendingNav,
      requireNavConfirmation,
      setRequireNavConfirmation,
      sessionName,
      agent,
      applyNav: (id) => resolve(id, 'applied'),
      holdNav: (id) => resolve(id, 'held'),
      isNavHeld: (id) => heldIds().includes(id),
      dismissNav: (id) => resolve(id, 'dismissed'),
      navigate,
      clearFocus,
      dispose,
    };
  });
}
