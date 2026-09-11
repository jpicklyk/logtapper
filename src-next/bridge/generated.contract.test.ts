// Compile-time contract test: pins the shape of the highest-traffic ts-rs
// generated types so a Rust-side field rename/removal fails `tsc` here first,
// rather than surfacing as a runtime mismatch somewhere deep in the app. Every
// assertion below is compile-time only (`satisfies` / `expectTypeOf`) — there
// is nothing to execute, so one trivial runtime `expect` is included purely so
// vitest counts this file as a real, passing test rather than an empty suite.
//
// `Page`/`Sampled` have no hand-written twin in `./types` (see `types.ts`'s
// header comment), so they're imported directly from `./generated` here —
// this file exists specifically to check the generated output itself.
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ViewLine,
  SessionMetadata,
  StateSnapshot,
  Bookmark,
  ViewMode,
  HighlightKind,
  LogLevel,
} from './types';
import type { Page, Sampled } from './generated';

describe('generated bindings contract', () => {
  it('pins ViewLine, SessionMetadata, StateSnapshot, Bookmark, Page<T>, Sampled<T>, ViewMode, HighlightKind, LogLevel', () => {
    const viewLine = {
      lineNum: 0,
      virtualIndex: 0,
      raw: '',
      level: 'Info',
      tag: '',
      message: '',
      timestamp: 0,
      pid: 0,
      tid: 0,
      sourceId: '',
      highlights: [],
      matchedBy: [],
      isContext: false,
    } satisfies ViewLine;
    void viewLine;

    const sessionMetadata = {
      sessionId: '',
      sourceName: '',
      sourceType: '',
      totalLines: 0,
      fileSize: 0,
      isLive: false,
      isIndexing: false,
      firstTimestamp: null,
      lastTimestamp: null,
      logLevelDistribution: {},
      topTags: [],
    } satisfies SessionMetadata;
    void sessionMetadata;

    const stateSnapshot = {
      lineNum: 0,
      timestamp: 0,
      fields: {},
      initializedFields: [],
      sourceSections: [],
    } satisfies StateSnapshot;
    void stateSnapshot;

    const bookmark = {
      id: '',
      sessionId: '',
      lineNumber: 0,
      label: '',
      note: '',
      createdBy: 'User',
      createdAt: 0,
    } satisfies Bookmark;
    void bookmark;

    const page = {
      items: [] as ViewLine[],
      offset: 0,
      limit: 0,
      total: 0,
      truncated: false,
    } satisfies Page<ViewLine>;
    void page;

    const sampled = {
      items: [] as ViewLine[],
      strategy: { kind: 'uniform' },
      sampledCount: 0,
      scannedLines: 0,
      truncated: false,
    } satisfies Sampled<ViewLine>;
    void sampled;

    expectTypeOf<ViewMode>().toEqualTypeOf<
      | { mode: 'Full' }
      | { mode: 'Processor' }
      | { mode: 'Focus'; center: number }
    >();

    expectTypeOf<HighlightKind>().toEqualTypeOf<
      | { type: 'Search' }
      | { type: 'SearchActive' }
      | { type: 'ProcessorMatch'; id: string }
      | { type: 'ExtractedField'; name: string }
      | { type: 'PiiReplaced' }
    >();

    expectTypeOf<LogLevel>().toEqualTypeOf<'Verbose' | 'Debug' | 'Info' | 'Warn' | 'Error' | 'Fatal'>();

    // Real runtime assertion — see file header.
    expect(true).toBe(true);
  });
});
