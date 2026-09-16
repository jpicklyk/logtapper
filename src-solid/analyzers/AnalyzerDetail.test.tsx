/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { MatchedLine, PipelineRunSummary, ProcessorSummary } from '@bridge/types';
import { AnalyzerDetail } from './AnalyzerDetail';
import { MATCHED_PREVIEW_CAP } from './analyzerStore';
import type { AnalyzerStore, MatchedLineDigest } from './analyzerStore';

afterEach(cleanup);

function proc(overrides: Partial<ProcessorSummary> = {}): ProcessorSummary {
  return {
    id: 'p1',
    name: 'USB failures',
    version: '1.0.0',
    description: 'finds USB enumeration failures',
    tags: [],
    builtin: false,
    processorType: 'reporter',
    group: 'usb',
    varsMeta: [],
    deprecated: false,
    hasSchema: true,
    trackerSections: [],
    sourceTypes: ['logcat'],
    ...overrides,
  };
}

/** The store hands out a digest, not the raw rows — see `MatchedLineDigest`. */
function digest(lines: MatchedLine[]): MatchedLineDigest {
  return {
    lineNums: lines.map((l) => l.lineNum).sort((a, b) => a - b),
    preview: lines.slice(0, MATCHED_PREVIEW_CAP),
    total: lines.length,
  };
}

function fakeStore(options: {
  processor?: ProcessorSummary;
  summary?: PipelineRunSummary;
  vars?: Record<string, unknown>;
  matchedLines?: MatchedLine[];
  lastRunAt?: () => number | null;
} = {}): AnalyzerStore {
  const processor = options.processor ?? proc();
  return {
    byId: () => processor,
    summaryFor: () => options.summary,
    lastRunAt: options.lastRunAt ?? (() => null),
    vars: vi.fn(() => Promise.resolve(options.vars ?? {})),
    matchedLines: vi.fn(() => Promise.resolve(digest(options.matchedLines ?? []))),
    showMatched: vi.fn(() => Promise.resolve()),
  } as unknown as AnalyzerStore;
}

describe('AnalyzerDetail', () => {
  it('renders description, group and source types', async () => {
    const store = fakeStore();
    render(() => <AnalyzerDetail store={store} sessionId="s1" processorId="p1" onClose={vi.fn()} />);
    expect(await screen.findByText('finds USB enumeration failures')).toBeTruthy();
    expect(screen.getByText('usb')).toBeTruthy();
    expect(screen.getByText('logcat')).toBeTruthy();
  });

  it('renders a vars table from the store, grouped by kind', async () => {
    const store = fakeStore({
      vars: { count: 7, device: 'Pixel', by_reason: { timeout: 5, denied: 2 } },
    });
    render(() => <AnalyzerDetail store={store} sessionId="s1" processorId="p1" onClose={vi.fn()} />);
    expect(await screen.findByText('7')).toBeTruthy();
    expect(screen.getByText('Pixel')).toBeTruthy();
    expect(screen.getByText('timeout')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('caps the matched-line list at 500 and "Show in viewer" calls showMatched then closes', async () => {
    const lines: MatchedLine[] = Array.from({ length: 600 }, (_, i) => ({ lineNum: i, raw: `line ${i}` }));
    const store = fakeStore({ matchedLines: lines });
    const onClose = vi.fn();
    render(() => <AnalyzerDetail store={store} sessionId="s1" processorId="p1" onClose={onClose} />);
    expect(await screen.findByText(/Matched lines \(600\)/)).toBeTruthy();
    expect(screen.getByText(/Showing first 500 of 600/)).toBeTruthy();
    fireEvent.click(screen.getByText('Show in viewer'));
    expect(store.showMatched).toHaveBeenCalledWith('s1', 'p1');
    expect(onClose).toHaveBeenCalled();
  });

  it('refetches its matched lines when a new run lands (D1-M7)', async () => {
    const [lastRunAt, setLastRunAt] = createSignal<number | null>(1);
    const store = fakeStore({ matchedLines: [{ lineNum: 1, raw: 'a' }], lastRunAt });
    render(() => <AnalyzerDetail store={store} sessionId="s1" processorId="p1" onClose={vi.fn()} />);
    await screen.findByText(/Matched lines \(1\)/);
    expect(store.matchedLines).toHaveBeenCalledTimes(1);

    // The store's own cache key is a non-reactive run counter, so without
    // tracking `lastRunAt` the drawer kept showing the previous run's lines.
    setLastRunAt(2);
    await Promise.resolve();
    expect(store.matchedLines).toHaveBeenCalledTimes(2);
  });

  it('is a dialog a keyboard user can leave: role, label and Escape', async () => {
    const onClose = vi.fn();
    const store = fakeStore();
    render(() => <AnalyzerDetail store={store} sessionId="s1" processorId="p1" onClose={onClose} />);
    const overlay = await screen.findByTestId('analyzer-detail');
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(overlay.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('USB failures');
    expect(document.activeElement).toBe(overlay);
    fireEvent.keyDown(overlay, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not show a matched-lines section for a non-reporter', async () => {
    const store = fakeStore({ processor: proc({ processorType: 'state_tracker' }) });
    render(() => <AnalyzerDetail store={store} sessionId="s1" processorId="p1" onClose={vi.fn()} />);
    await screen.findByText('finds USB enumeration failures');
    expect(screen.queryByText(/Matched lines/)).toBeNull();
  });
});
