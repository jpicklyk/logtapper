import type { SourceType } from '../bridge/types';

/** Typed event map for the internal application event bus. */
export type AppEvents = {
  // ── Generic lifecycle (all source types) ───────────────────────────────────
  /**
   * Fired just before a file load or ADB stream starts for a given pane.
   * Consumers use `paneId` to determine whether to clear their state — only
   * the focused pane's results should be reset; background-pane loads must not
   * disrupt what the user is currently viewing.
   */
  'session:pre-load':       { paneId: string };
  /**
   * `tabId` is the pre-assigned tab ID for the logviewer tab that will be
   * created (or updated) for this session. Use this ID to look up the tab's
   * session in tabSessionMap when switching between logviewer tabs.
   *
   * When `isNewTab` is true, a second file is being opened alongside an
   * existing one in the same pane. `previousSessionId` is the session that
   * was active before — workspace layout uses it to retroactively bind the
   * pre-existing logviewer tab's session.
   */
  'session:loaded':         { sessionId: string; paneId: string; sourceName: string; sourceType: SourceType;
                              tabId: string; isNewTab?: boolean; previousSessionId?: string };
  'session:closed':         { sessionId: string; paneId: string; sourceType: SourceType; tabId?: string };
  'session:focused':        { sessionId: string | null; paneId: string | null };
  'session:indexing-complete': { sessionId: string; totalLines: number };

  // ── Dumpstate / Bugreport specific ─────────────────────────────────────────
  'session:dumpstate:opened':            { sessionId: string; paneId: string; sourceName: string };
  'session:dumpstate:indexing-complete': { sessionId: string; totalLines: number };

  // ── Logcat file specific ────────────────────────────────────────────────────
  'session:logcat:opened':  { sessionId: string; paneId: string; sourceName: string };

  // ── ADB streaming (always logcat) ──────────────────────────────────────────
  'stream:started':         { sessionId: string; paneId: string; deviceSerial: string };
  'stream:stopped':         { sessionId: string; paneId: string };

  // ── Pipeline ───────────────────────────────────────────────────────────────
  'pipeline:completed':     { sessionId: string; runCount: number;
                              hasTrackers: boolean; hasReporters: boolean; hasCorrelators: boolean };
  'pipeline:cleared':       undefined;
  'pipeline:chain-changed': { chain: string[] };

  // ── Layout / navigation ───────────────────────────────────────────────────
  'layout:open-tab':        { type: string };
  /** Fired when a logviewer tab is explicitly closed via the UI tab bar. */
  'layout:logviewer-tab-closed': { tabId: string; paneId: string };
  /** Fired when the user switches to a logviewer tab that has its own session. */
  'layout:logviewer-tab-activated': { tabId: string; paneId: string };
  /** Fired by workspace layout to tell useLogViewer to bind a tab ID to a session ID. */
  'layout:tab-session-bind': { tabId: string; sessionId: string; paneId: string };
  /** Fired by workspace fallback path when a session was registered under a placeholder
   *  pane ID (e.g. 'primary') but the tab was actually placed in a different pane. */
  'layout:pane-session-remap': { originalPaneId: string; actualPaneId: string; sessionId: string };
  'navigate:jump':          { lineNum: number };
};
