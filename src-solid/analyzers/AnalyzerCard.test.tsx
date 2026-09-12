/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { CorrelatorResult, PipelineRunSummary, ProcessorSummary } from '@bridge/types';
import { AnalyzerCard } from './AnalyzerCard';
import type { AnalyzerController, AnalyzerStore } from './analyzerStore';

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
    group: null,
    varsMeta: [],
    deprecated: false,
    hasSchema: true,
    trackerSections: [],
    sourceTypes: [],
    ...overrides,
  };
}

function summary(overrides: Partial<PipelineRunSummary> = {}): PipelineRunSummary {
  return {
    processorId: 'p1',
    matchedLines: 5,
    emissionCount: 0,
    scriptErrors: 0,
    scannedFrom: 0,
    ...overrides,
  };
}

function fakeStore(overrides: Partial<AnalyzerStore> = {}): AnalyzerStore {
  return {
    correlatorEvents: vi.fn(() => Promise.resolve({ guidance: null, events: [] } as CorrelatorResult)),
    showMatched: vi.fn(() => Promise.resolve()),
    clearMatched: vi.fn(),
    ...overrides,
  } as unknown as AnalyzerStore;
}

function fakeController(overrides: Partial<AnalyzerController> = {}): AnalyzerController {
  return {
    setLineSet: vi.fn(),
    scrollToLine: vi.fn(),
    ...overrides,
  };
}

describe('AnalyzerCard', () => {
  it('reporter: shows matched count and calls showMatched/clearMatched', () => {
    const store = fakeStore();
    render(() => (
      <AnalyzerCard
        store={store}
        controller={fakeController()}
        sessionId="s1"
        processor={proc()}
        disabled={false}
        running={false}
        summary={summary({ matchedLines: 42 })}
      />
    ));
    expect(screen.getByText('42 matched')).toBeTruthy();
    fireEvent.click(screen.getByText('Show matched lines'));
    expect(store.showMatched).toHaveBeenCalledWith('s1', 'p1');
    fireEvent.click(screen.getByText('Clear'));
    expect(store.clearMatched).toHaveBeenCalledWith('s1');
  });

  it('state_tracker: shows badges and calls onOpenDeviceState', () => {
    const onOpenDeviceState = vi.fn();
    render(() => (
      <AnalyzerCard
        store={fakeStore()}
        controller={fakeController()}
        sessionId="s1"
        processor={proc({
          id: 'wifi',
          processorType: 'state_tracker',
          trackerMode: 'time_series',
          trackerSections: ['wifi'],
          trackerTimeline: true,
        })}
        disabled={false}
        running={false}
        summary={summary({ processorId: 'wifi', matchedLines: 3 })}
        onOpenDeviceState={onOpenDeviceState}
      />
    ));
    expect(screen.getByText('time_series')).toBeTruthy();
    expect(screen.getByText('wifi')).toBeTruthy();
    expect(screen.getByText('timeline')).toBeTruthy();
    fireEvent.click(screen.getByText('Open device state'));
    expect(onOpenDeviceState).toHaveBeenCalledWith('wifi');
  });

  it('correlator: fetches events and scrolls on chip click', async () => {
    const events: CorrelatorResult['events'] = [
      { triggerLineNum: 9, triggerTimestamp: 0, triggerSourceId: 'a', triggerFields: {}, triggerRawLine: '', matchedSources: {}, message: 'm1' },
      { triggerLineNum: 20, triggerTimestamp: 0, triggerSourceId: 'a', triggerFields: {}, triggerRawLine: '', matchedSources: {}, message: 'm2' },
    ];
    const controller = fakeController();
    const store = fakeStore({ correlatorEvents: vi.fn(() => Promise.resolve({ guidance: null, events })) });
    render(() => (
      <AnalyzerCard
        store={store}
        controller={controller}
        sessionId="s1"
        processor={proc({ id: 'corr', processorType: 'correlator' })}
        disabled={false}
        running={false}
        summary={summary({ processorId: 'corr', matchedLines: 2 })}
      />
    ));
    const firstChip = await screen.findByText('first: line 10');
    fireEvent.click(firstChip);
    expect(controller.scrollToLine).toHaveBeenCalledWith('s1', 9, { source: 'user' });
    fireEvent.click(screen.getByText('last: line 21'));
    expect(controller.scrollToLine).toHaveBeenCalledWith('s1', 20, { source: 'user' });
  });

  it('transformer: generic row falls back to "--" with no summary', () => {
    render(() => (
      <AnalyzerCard
        store={fakeStore()}
        controller={fakeController()}
        sessionId="s1"
        processor={proc({ id: 't1', processorType: 'transformer' })}
        disabled={false}
        running={false}
      />
    ));
    expect(screen.getByText('--')).toBeTruthy();
  });

  it('shows the skipped banner instead of the stat line', () => {
    render(() => (
      <AnalyzerCard
        store={fakeStore()}
        controller={fakeController()}
        sessionId="s1"
        processor={proc()}
        disabled={false}
        running={false}
        summary={summary({ skipped: { reason: 'source_type_mismatch', declared: ['logcat'], actual: 'bugreport' } })}
      />
    ));
    expect(screen.getByText(/Not applicable to this bugreport source/)).toBeTruthy();
    expect(screen.queryByText('Show matched lines')).toBeNull();
  });

  it('shows script error count and message', () => {
    render(() => (
      <AnalyzerCard
        store={fakeStore()}
        controller={fakeController()}
        sessionId="s1"
        processor={proc()}
        disabled={false}
        running={false}
        summary={summary({ scriptErrors: 2, firstScriptError: 'bad expr' })}
      />
    ));
    expect(screen.getByText(/2 script errors/)).toBeTruthy();
    expect(screen.getByText(/bad expr/)).toBeTruthy();
  });

  it('pinned rows render with no checkbox or reorder buttons', () => {
    render(() => (
      <AnalyzerCard
        store={fakeStore()}
        controller={fakeController()}
        sessionId="s1"
        processor={proc({ id: '__pii_anonymizer', name: 'PII', processorType: 'transformer' })}
        disabled={false}
        running={false}
        pinned
      />
    ));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByLabelText('Move up')).toBeNull();
  });

  it('toggle checkbox and move buttons call their handlers, including Alt+Arrow keys', () => {
    const onToggle = vi.fn();
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    render(() => (
      <AnalyzerCard
        store={fakeStore()}
        controller={fakeController()}
        sessionId="s1"
        processor={proc()}
        disabled={false}
        running={false}
        index={1}
        total={3}
        onToggle={onToggle}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />
    ));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Move up'));
    expect(onMoveUp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Move down'));
    expect(onMoveDown).toHaveBeenCalledTimes(1);

    const card = screen.getByTestId('analyzer-card-p1');
    fireEvent.keyDown(card, { key: 'ArrowUp', altKey: true });
    expect(onMoveUp).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(card, { key: 'ArrowDown', altKey: true });
    expect(onMoveDown).toHaveBeenCalledTimes(2);
  });

  it('shows a running progress bar and the last-run caller badge', () => {
    render(() => (
      <AnalyzerCard
        store={fakeStore()}
        controller={fakeController()}
        sessionId="s1"
        processor={proc()}
        disabled={false}
        running
        progress={{ processorId: 'p1', linesProcessed: 50, totalLines: 100, percent: 50 }}
        lastRunCaller={{ kind: 'agent', client: 'claude' }}
      />
    ));
    expect(screen.getByText('Ran')).toBeTruthy();
  });
});
