/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { PipelineRunResult, ProcessorSummary } from '@bridge/types';
import { AnalyzersPanel } from './AnalyzersPanel';
import type { AnalyzerController, AnalyzerStore, SessionChainSnapshot } from './analyzerStore';

afterEach(cleanup);

function proc(id: string, overrides: Partial<ProcessorSummary> = {}): ProcessorSummary {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: '',
    tags: [],
    builtin: id === '__pii_anonymizer',
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

/** A hand-built `AnalyzerStore` double, reactive enough for the panel's
 *  memos to re-render on toggle/reorder/run — the panel is tested as a pure
 *  renderer over the store's public surface, not against the real store
 *  (that is `analyzerStore.test.ts`'s job, already done by W4a). */
function fakeStore(
  overrides: { result?: PipelineRunResult | null; lastError?: (sessionId: string) => string | null } = {},
): AnalyzerStore {
  const catalog = [proc('p1'), proc('p2'), proc('__pii_anonymizer')];
  const [order, setOrder] = createSignal<string[]>(['p1', 'p2']);
  const [disabled, setDisabled] = createSignal<string[]>([]);
  const [running, setRunning] = createSignal(false);
  const [result, setResult] = createSignal<PipelineRunResult | null>(overrides.result ?? null);

  const chain = (): SessionChainSnapshot => ({
    order: order(),
    disabled: disabled(),
    active: order().filter((id) => !disabled().includes(id)),
  });

  return {
    catalog: () => catalog,
    packs: () => [],
    refreshCatalog: vi.fn(() => Promise.resolve()),
    byId: (id: string) => catalog.find((p) => p.id === id),
    groups: () => ({ packGroups: [], standaloneProcessors: catalog }),
    trackers: () => [],
    pinnedTail: () => ['__pii_anonymizer'],
    chain: () => chain(),
    add: vi.fn(),
    remove: vi.fn(),
    toggle: vi.fn((_sid: string, id: string) =>
      setDisabled((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    ),
    reorder: vi.fn((_sid: string, from: number, to: number) =>
      setOrder((prev) => {
        const arr = [...prev];
        const clampedTo = Math.max(0, Math.min(to, arr.length - 1));
        const [moved] = arr.splice(from, 1);
        arr.splice(clampedTo, 0, moved);
        return arr;
      }),
    ),
    resetToDefault: vi.fn(),
    addedBy: () => null,
    running: () => running(),
    progress: () => new Map(),
    result: () => result(),
    lastError: overrides.lastError ?? (() => null),
    lastRunAt: () => null,
    catalogError: () => null,
    run: vi.fn(() => {
      setRunning(true);
      return Promise.resolve();
    }),
    stop: vi.fn(() => {
      setRunning(false);
      return Promise.resolve();
    }),
    summaryFor: () => undefined,
    matchedLines: vi.fn(() => Promise.resolve([])),
    correlatorEvents: vi.fn(() => Promise.resolve({ guidance: null, events: [] })),
    vars: vi.fn(() => Promise.resolve({})),
    showMatched: vi.fn(() => Promise.resolve()),
    clearMatched: vi.fn(),
    installFromFile: vi.fn(() => Promise.resolve()),
    uninstall: vi.fn(() => Promise.resolve()),
    pipelineChainProvider: () => ({ chain: [], disabledIds: [] }),
    applyWorkspaceChain: vi.fn(),
    dispose: vi.fn(),
    _setResult: setResult,
  } as unknown as AnalyzerStore & { _setResult: typeof setResult };
}

function fakeController(): AnalyzerController {
  return { setLineSet: vi.fn(), scrollToLine: vi.fn() };
}

describe('AnalyzersPanel', () => {
  it('renders active analyzers plus the pinned tail row, and toggle calls the store', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    const checkboxes = screen.getAllByRole('checkbox');
    // Two editable cards (p1, p2) — the pinned anonymizer gets no checkbox.
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    expect(store.toggle).toHaveBeenCalledWith('s1', 'p1');
    expect(screen.getByText('p1').closest('div')).toBeTruthy();
  });

  it('move-down on the first card reorders through the store', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    const downButtons = screen.getAllByLabelText('Move down');
    fireEvent.click(downButtons[0]);
    expect(store.reorder).toHaveBeenCalledWith('s1', 0, 1);
  });

  it('pinned row is not togglable or reorderable', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    expect(screen.getAllByLabelText('Move up')).toHaveLength(2);
  });

  it('the × on a card removes that analyzer from the chain, and the pinned row has none', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    expect(screen.queryByLabelText('Remove __pii_anonymizer')).toBeNull();
    fireEvent.click(screen.getByLabelText('Remove p2'));
    expect(store.remove).toHaveBeenCalledWith('s1', 'p2');
    expect(store.remove).toHaveBeenCalledTimes(1);
  });

  it('Run starts the run and Stop calls store.stop', async () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    fireEvent.click(screen.getByText('Run'));
    expect(store.run).toHaveBeenCalledWith('s1');
    const stopButton = await screen.findByText('Stop');
    fireEvent.click(stopButton);
    expect(store.stop).toHaveBeenCalledWith('s1');
  });

  it('shows the not-applicable banner when a summary is skipped', () => {
    const result: PipelineRunResult = {
      sessionId: 's1',
      effectiveProcessorIds: ['p1'],
      summaries: [
        {
          processorId: 'p1',
          matchedLines: 0,
          emissionCount: 0,
          scriptErrors: 0,
          scannedFrom: 0,
          skipped: { reason: 'source_type_mismatch', declared: ['logcat'], actual: 'bugreport' },
        },
      ],
    };
    const store = fakeStore({ result });
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    expect(screen.getByText(/not applicable to this bugreport source/)).toBeTruthy();
  });

  it('renders a failed run instead of silently resetting the Run button (D1-H2)', () => {
    const store = fakeStore({ lastError: () => 'rhai compile error: line 4' });
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    const banner = screen.getByTestId('analyzer-run-error');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('rhai compile error: line 4');
  });

  it('shows no error banner when the last run succeeded', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    expect(screen.queryByTestId('analyzer-run-error')).toBeNull();
  });

  describe('session switch (D1-M4)', () => {
    it('closes the add-analyzer drawer so it cannot add to the session the user left', async () => {
      const store = fakeStore();
      const [sessionId, setSessionId] = createSignal('A');
      render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId={sessionId()} />);
      fireEvent.click(screen.getByText('Add analyzer'));
      expect(screen.getByTestId('add-analyzer')).toBeTruthy();

      // `App.tsx` mounts this panel under a non-keyed `<Show>`, so a tab switch
      // mutates `props.sessionId` on the SAME instance — the drawer used to
      // stay open, visually unchanged, now pointed at B.
      setSessionId('B');
      await Promise.resolve();
      expect(screen.queryByTestId('add-analyzer')).toBeNull();
    });

    it('closes the detail drawer so it cannot fetch another session\'s vars for it', async () => {
      const store = fakeStore();
      const [sessionId, setSessionId] = createSignal('A');
      render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId={sessionId()} />);
      fireEvent.click(screen.getByText('p1'));
      expect(screen.getByTestId('analyzer-detail')).toBeTruthy();

      setSessionId('B');
      await Promise.resolve();
      expect(screen.queryByTestId('analyzer-detail')).toBeNull();
    });

    it('does not close a drawer opened on the first render', async () => {
      const store = fakeStore();
      render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="A" />);
      fireEvent.click(screen.getByText('Add analyzer'));
      await Promise.resolve();
      expect(screen.getByTestId('add-analyzer')).toBeTruthy();
    });
  });

  it('shows the empty state when there is nothing active or pinned', () => {
    const store = fakeStore();
    (store as unknown as { catalog: () => ProcessorSummary[] }).catalog = () => [];
    (store as unknown as { chain: () => SessionChainSnapshot }).chain = () => ({ order: [], disabled: [], active: [] });
    (store as unknown as { pinnedTail: () => string[] }).pinnedTail = () => [];
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" />);
    expect(screen.getByText('No active analyzers.')).toBeTruthy();
  });
});
