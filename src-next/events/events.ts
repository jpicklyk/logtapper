import type { SourceType } from '../bridge/types';

/** Typed event map for the internal application event bus. */
export type AppEvents = {
  // ── Generic lifecycle (all source types) ───────────────────────────────────
  'session:pre-load':       undefined;
  'session:loaded':         { sessionId: string; paneId: string; sourceName: string; sourceType: SourceType };
  'session:closed':         { sessionId: string; paneId: string; sourceType: SourceType };
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
  'layout:logviewer-tab-closed': { paneId: string };
  'navigate:jump':          { lineNum: number };
};
