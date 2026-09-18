/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { AnonymizerMode, PipelineRunResult, ProcessorSummary } from '@bridge/types';
import { AnalyzersPanel } from './AnalyzersPanel';
import type { AnalyzersPanelProps } from './AnalyzersPanel';
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

/** The settings-store slice the pinned card's mode control needs; the mode is
 *  a signal so a test can flip it and watch the description follow. */
function modeProps(initial: AnonymizerMode = 'external', extra: Partial<AnalyzersPanelProps> = {}) {
  const [mode, setMode] = createSignal<AnonymizerMode>(initial);
  const setAnonymizerMode = vi.fn((next: AnonymizerMode) => {
    setMode(next);
    return Promise.resolve();
  });
  return { anonymizerMode: mode, setAnonymizerMode, ...extra };
}

describe('AnalyzersPanel', () => {
  it('renders active analyzers plus the pinned tail row, and toggle calls the store', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // Two editable cards (p1, p2) — the pinned anonymizer gets no checkbox.
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    expect(store.toggle).toHaveBeenCalledWith('s1', 'p1');
    expect(screen.getByText('p1').closest('div')).toBeTruthy();
  });

  it('move-down on the first card reorders through the store', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
    const downButtons = screen.getAllByLabelText('Move down');
    fireEvent.click(downButtons[0]);
    expect(store.reorder).toHaveBeenCalledWith('s1', 0, 1);
  });

  it('pinned row is not togglable or reorderable', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
    expect(screen.getAllByLabelText('Move up')).toHaveLength(2);
  });

  it('the × on a card removes that analyzer from the chain, and the pinned row has none', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
    expect(screen.queryByLabelText('Remove __pii_anonymizer')).toBeNull();
    fireEvent.click(screen.getByLabelText('Remove p2'));
    expect(store.remove).toHaveBeenCalledWith('s1', 'p2');
    expect(store.remove).toHaveBeenCalledTimes(1);
  });

  it('Run starts the run and Stop calls store.stop', async () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
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
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
    expect(screen.getByText(/not applicable to this bugreport source/)).toBeTruthy();
  });

  it('renders a failed run instead of silently resetting the Run button (D1-H2)', () => {
    const store = fakeStore({ lastError: () => 'rhai compile error: line 4' });
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
    const banner = screen.getByTestId('analyzer-run-error');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('rhai compile error: line 4');
  });

  it('shows no error banner when the last run succeeded', () => {
    const store = fakeStore();
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
    expect(screen.queryByTestId('analyzer-run-error')).toBeNull();
  });

  describe('session switch (D1-M4)', () => {
    it('closes the add-analyzer drawer so it cannot add to the session the user left', async () => {
      const store = fakeStore();
      const [sessionId, setSessionId] = createSignal('A');
      render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId={sessionId()} {...modeProps()} />);
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
      render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId={sessionId()} {...modeProps()} />);
      fireEvent.click(screen.getByText('p1'));
      expect(screen.getByTestId('analyzer-detail')).toBeTruthy();

      setSessionId('B');
      await Promise.resolve();
      expect(screen.queryByTestId('analyzer-detail')).toBeNull();
    });

    it('does not close a drawer opened on the first render', async () => {
      const store = fakeStore();
      render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="A" {...modeProps()} />);
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
    render(() => <AnalyzersPanel store={store} controller={fakeController()} sessionId="s1" {...modeProps()} />);
    expect(screen.getByText('No active analyzers.')).toBeTruthy();
  });

  describe('pinned PII Anonymizer card — the mode control', () => {
    const card = () => screen.getByTestId('analyzer-card-__pii_anonymizer');
    const radios = () => within(card()).getAllByRole('radio') as HTMLButtonElement[];
    const description = () => within(card()).getByTestId('anonymizer-mode-description').textContent ?? '';
    /** A write is in flight until its promise settles; the control ignores a
     *  second selection until then, so consecutive actions wait a macrotask. */
    const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it('renders All | External | None as a radiogroup with the current mode checked', () => {
      render(() => <AnalyzersPanel store={fakeStore()} controller={fakeController()} sessionId="s1" {...modeProps('external')} />);
      expect(within(card()).getByRole('radiogroup', { name: 'Anonymizer mode' })).toBeTruthy();
      expect(radios().map((r) => r.textContent)).toEqual(['All', 'External', 'None']);
      expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
      // Roving tabindex: only the checked option is a tab stop.
      expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
      expect(within(card()).getByText('Applies to every session')).toBeTruthy();
      // The other cards keep their stat lines — the control is the pinned row's alone.
      expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    });

    it('describes each mode in its own words, None in the warning colour', async () => {
      const props = modeProps('all');
      render(() => <AnalyzersPanel store={fakeStore()} controller={fakeController()} sessionId="s1" {...props} />);
      expect(description()).toBe('All — viewer, agents and exports are anonymized');
      fireEvent.click(radios()[1]);
      await settled();
      expect(description()).toBe('External — agents and exports are anonymized; the viewer shows raw text');
      fireEvent.click(radios()[2]);
      await settled();
      expect(description()).toBe('None — raw text everywhere — agents included');
      expect(within(card()).getByTestId('anonymizer-mode-description').className).toMatch(/Warn/);
    });

    it('clicking an option calls setAnonymizerMode with it, and re-clicking the checked one does not', async () => {
      const props = modeProps('external');
      render(() => <AnalyzersPanel store={fakeStore()} controller={fakeController()} sessionId="s1" {...props} />);
      fireEvent.click(radios()[0]);
      expect(props.setAnonymizerMode).toHaveBeenCalledWith('all');
      await settled();
      fireEvent.click(radios()[0]);
      expect(props.setAnonymizerMode).toHaveBeenCalledTimes(1);
    });

    it('arrow keys move the selection (and focus) like a native radio set', async () => {
      const props = modeProps('external');
      render(() => <AnalyzersPanel store={fakeStore()} controller={fakeController()} sessionId="s1" {...props} />);
      const group = within(card()).getByRole('radiogroup');
      radios()[1].focus();
      fireEvent.keyDown(group, { key: 'ArrowLeft' });
      expect(props.setAnonymizerMode).toHaveBeenLastCalledWith('all');
      expect(document.activeElement).toBe(radios()[0]);
      await settled();
      // Wraps around from the first to the last.
      fireEvent.keyDown(group, { key: 'ArrowLeft' });
      expect(props.setAnonymizerMode).toHaveBeenLastCalledWith('none');
      expect(document.activeElement).toBe(radios()[2]);
      await settled();
      fireEvent.keyDown(group, { key: 'Home' });
      expect(props.setAnonymizerMode).toHaveBeenLastCalledWith('all');
      await settled();
      fireEvent.keyDown(group, { key: 'End' });
      expect(props.setAnonymizerMode).toHaveBeenLastCalledWith('none');
      await settled();
      fireEvent.keyDown(group, { key: 'ArrowRight' });
      expect(props.setAnonymizerMode).toHaveBeenLastCalledWith('all');
      expect(props.setAnonymizerMode).toHaveBeenCalledTimes(5);
    });

    it('switching to None with an agent connected asks first, and a declined confirm changes nothing', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const props = modeProps('external', { agentConnected: () => true, bridgeRunning: () => true });
      render(() => <AnalyzersPanel store={fakeStore()} controller={fakeController()} sessionId="s1" {...props} />);
      fireEvent.click(radios()[2]);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(props.setAnonymizerMode).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      fireEvent.click(radios()[2]);
      expect(props.setAnonymizerMode).toHaveBeenCalledWith('none');
      await settled();
      // With the bridge up, the card carries the presence panel's warning inline.
      expect(description()).toContain('Agents read un-anonymized log text');
      confirm.mockRestore();
    });

    it('does not confirm when no agent is connected, nor for All/External', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const props = modeProps('external', { agentConnected: () => false });
      render(() => <AnalyzersPanel store={fakeStore()} controller={fakeController()} sessionId="s1" {...props} />);
      fireEvent.click(radios()[2]);
      expect(props.setAnonymizerMode).toHaveBeenCalledWith('none');
      // Bridge down: no inline agents warning even under None.
      expect(description()).not.toContain('Agents read');
      await settled();
      fireEvent.click(radios()[0]);
      expect(props.setAnonymizerMode).toHaveBeenCalledWith('all');
      expect(confirm).not.toHaveBeenCalled();
      confirm.mockRestore();
    });

    it('renders a rejected write as an alert on the card, not an unhandled rejection', async () => {
      const setAnonymizerMode = vi.fn(() => Promise.reject(new Error('disk full')));
      render(() => (
        <AnalyzersPanel
          store={fakeStore()}
          controller={fakeController()}
          sessionId="s1"
          anonymizerMode={() => 'external'}
          setAnonymizerMode={setAnonymizerMode}
        />
      ));
      fireEvent.click(radios()[0]);
      const alert = await within(card()).findByRole('alert');
      expect(alert.textContent).toContain('disk full');
    });

    it('stays disabled until the config has loaded', () => {
      const props = modeProps('external', { anonymizerLoading: () => true });
      render(() => <AnalyzersPanel store={fakeStore()} controller={fakeController()} sessionId="s1" {...props} />);
      expect(radios().every((r) => r.disabled)).toBe(true);
      fireEvent.click(radios()[0]);
      expect(props.setAnonymizerMode).not.toHaveBeenCalled();
    });
  });
});
