import { describe, it, expect } from 'vitest';
import type { PipelineRunSummary } from '../bridge/types';
import type { FilterState, IndexingProgress } from './SessionContext';
import type { SessionPipelineState } from './PipelineContext';
import type { TrackerSessionData } from './TrackerContext';

// ---------------------------------------------------------------------------
// SessionDataProvider extracts per-session slices from global Maps.
// These tests verify the extraction logic (pure functions) without React.
// ---------------------------------------------------------------------------

// Simulate the provider's slice extraction logic
function extractPipelineSlice(
  resultsBySession: Map<string, SessionPipelineState>,
  sessionId: string | null,
): SessionPipelineState | undefined {
  return sessionId ? resultsBySession.get(sessionId) : undefined;
}

function extractTrackerSlice(
  dataBySession: Record<string, TrackerSessionData>,
  sessionId: string | null,
): TrackerSessionData | undefined {
  return sessionId ? dataBySession[sessionId] : undefined;
}

function extractFilterSlice(
  filterStateBySession: Map<string, FilterState>,
  sessionId: string | null,
): FilterState {
  const empty: FilterState = {
    streamFilter: '', timeFilterStart: '', timeFilterEnd: '',
    filterScanning: false, filteredLineNums: null,
    filterParseError: null, sectionFilteredLineNums: null,
  };
  return sessionId ? (filterStateBySession.get(sessionId) ?? empty) : empty;
}

function extractIndexingSlice(
  indexingProgressBySession: Map<string, IndexingProgress | null>,
  sessionId: string | null,
): IndexingProgress | null {
  return sessionId ? (indexingProgressBySession.get(sessionId) ?? null) : null;
}

// ---------------------------------------------------------------------------
// Pipeline slice extraction
// ---------------------------------------------------------------------------
describe('pipeline slice extraction', () => {
  const makeResults = (_sessionId: string, matchedLines: number): SessionPipelineState => ({
    results: [{ processorId: 'p1', matchedLines, emissionCount: 0 }] as PipelineRunSummary[],
    runCount: 1,
    running: false,
    progress: null,
    error: null,
  });

  it('returns undefined for null sessionId', () => {
    const map = new Map([['sess-1', makeResults('sess-1', 10)]]);
    expect(extractPipelineSlice(map, null)).toBeUndefined();
  });

  it('returns undefined for unknown sessionId', () => {
    const map = new Map([['sess-1', makeResults('sess-1', 10)]]);
    expect(extractPipelineSlice(map, 'sess-999')).toBeUndefined();
  });

  it('returns the correct session slice', () => {
    const map = new Map([
      ['sess-A', makeResults('sess-A', 10)],
      ['sess-B', makeResults('sess-B', 20)],
    ]);

    const sliceA = extractPipelineSlice(map, 'sess-A');
    const sliceB = extractPipelineSlice(map, 'sess-B');

    expect(sliceA?.results[0].matchedLines).toBe(10);
    expect(sliceB?.results[0].matchedLines).toBe(20);
  });

  it('session A slice is unaffected when session B data changes', () => {
    const sliceA = makeResults('sess-A', 10);
    const map = new Map([['sess-A', sliceA], ['sess-B', makeResults('sess-B', 20)]]);

    // Simulate session B getting updated
    const updatedMap = new Map(map);
    updatedMap.set('sess-B', makeResults('sess-B', 30));

    // Session A's slice is the same reference — no re-render needed
    expect(extractPipelineSlice(updatedMap, 'sess-A')).toBe(sliceA);
  });
});

// ---------------------------------------------------------------------------
// Tracker slice extraction
// ---------------------------------------------------------------------------
describe('tracker slice extraction', () => {
  it('returns undefined for null sessionId', () => {
    const data = { 'sess-1': { updateCounts: {}, allLineNums: new Set<number>(), byLine: new Map() } };
    expect(extractTrackerSlice(data, null)).toBeUndefined();
  });

  it('returns undefined for unknown sessionId', () => {
    expect(extractTrackerSlice({}, 'sess-999')).toBeUndefined();
  });

  it('returns the correct session slice', () => {
    const data: Record<string, TrackerSessionData> = {
      'sess-A': { updateCounts: { t1: 5 }, allLineNums: new Set([10, 20]), byLine: new Map() },
      'sess-B': { updateCounts: { t1: 3 }, allLineNums: new Set([30]), byLine: new Map() },
    };

    expect(extractTrackerSlice(data, 'sess-A')?.updateCounts.t1).toBe(5);
    expect(extractTrackerSlice(data, 'sess-B')?.allLineNums.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Filter slice extraction
// ---------------------------------------------------------------------------
describe('filter slice extraction', () => {
  it('returns empty filter for null sessionId', () => {
    const map = new Map<string, FilterState>();
    const result = extractFilterSlice(map, null);
    expect(result.streamFilter).toBe('');
    expect(result.filteredLineNums).toBeNull();
  });

  it('returns empty filter for unknown sessionId', () => {
    const result = extractFilterSlice(new Map(), 'sess-unknown');
    expect(result.filterScanning).toBe(false);
  });

  it('returns the session filter state', () => {
    const filter: FilterState = {
      streamFilter: 'level:error',
      timeFilterStart: '12:00',
      timeFilterEnd: '13:00',
      filterScanning: true,
      filteredLineNums: [1, 5, 10],
      filterParseError: null,
      sectionFilteredLineNums: null,
    };
    const map = new Map([['sess-1', filter]]);

    const result = extractFilterSlice(map, 'sess-1');
    expect(result.streamFilter).toBe('level:error');
    expect(result.filterScanning).toBe(true);
    expect(result.filteredLineNums).toEqual([1, 5, 10]);
  });
});

// ---------------------------------------------------------------------------
// Indexing progress slice extraction
// ---------------------------------------------------------------------------
describe('indexing progress slice extraction', () => {
  it('returns null for null sessionId', () => {
    expect(extractIndexingSlice(new Map(), null)).toBeNull();
  });

  it('returns null for unknown sessionId', () => {
    expect(extractIndexingSlice(new Map(), 'sess-unknown')).toBeNull();
  });

  it('returns the session progress', () => {
    const progress: IndexingProgress = { linesIndexed: 50000, totalLines: 100000, percent: 50, done: false };
    const map = new Map([['sess-1', progress]]);

    expect(extractIndexingSlice(map, 'sess-1')).toEqual(progress);
  });

  it('returns null when session has no progress (already done)', () => {
    const map = new Map<string, IndexingProgress | null>([['sess-1', null]]);
    expect(extractIndexingSlice(map, 'sess-1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cross-session isolation (the key property)
// ---------------------------------------------------------------------------
describe('cross-session isolation', () => {
  it('changing session B data does not affect session A slice references', () => {
    const filterA: FilterState = {
      streamFilter: 'tag:MyApp', timeFilterStart: '', timeFilterEnd: '',
      filterScanning: false, filteredLineNums: [1, 2, 3],
      filterParseError: null, sectionFilteredLineNums: null,
    };
    const filterB: FilterState = {
      streamFilter: 'level:warn', timeFilterStart: '', timeFilterEnd: '',
      filterScanning: true, filteredLineNums: null,
      filterParseError: null, sectionFilteredLineNums: null,
    };

    const map = new Map([['sess-A', filterA], ['sess-B', filterB]]);

    const sliceA1 = extractFilterSlice(map, 'sess-A');

    // Simulate session B filter completing (new Map entry)
    const updatedMap = new Map(map);
    updatedMap.set('sess-B', { ...filterB, filterScanning: false, filteredLineNums: [10, 20] });

    const sliceA2 = extractFilterSlice(updatedMap, 'sess-A');

    // Session A's slice is the same object — React.useMemo would bail out
    expect(sliceA1).toBe(sliceA2);
  });

  it('each session gets independent pipeline results', () => {
    const map = new Map<string, SessionPipelineState>([
      ['sess-A', {
        results: [{ processorId: 'p1', matchedLines: 100, emissionCount: 5 }] as PipelineRunSummary[],
        runCount: 2, running: false, progress: null, error: null,
      }],
      ['sess-B', {
        results: [{ processorId: 'p1', matchedLines: 0, emissionCount: 0 }] as PipelineRunSummary[],
        runCount: 0, running: true, progress: { current: 500, total: 10000 }, error: null,
      }],
    ]);

    const a = extractPipelineSlice(map, 'sess-A')!;
    const b = extractPipelineSlice(map, 'sess-B')!;

    expect(a.runCount).toBe(2);
    expect(a.running).toBe(false);
    expect(b.runCount).toBe(0);
    expect(b.running).toBe(true);
    expect(b.progress).toEqual({ current: 500, total: 10000 });
  });
});
