/** Typed event map for the internal application event bus. */
export type AppEvents = {
  'session:pre-load':       undefined;
  'session:loaded':         { sourceName: string; sourceType: string; sessionId: string };
  'session:closed':         undefined;
  'stream:started':         { sessionId: string; deviceSerial: string };
  'stream:stopped':         { sessionId: string };
  'pipeline:completed':     { sessionId: string; runCount: number;
                              hasTrackers: boolean; hasReporters: boolean; hasCorrelators: boolean };
  'pipeline:cleared':       undefined;
  'pipeline:chain-changed': { chain: string[] };
  'layout:open-tab':        { type: string };
  'navigate:jump':          { lineNum: number };
};
