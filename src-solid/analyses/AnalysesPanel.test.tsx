/** @jsxImportSource solid-js */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { AnalysisArtifact, SourceReference } from '@bridge/types';
import { AnalysesPanel } from './AnalysesPanel';
import type { AnalysesStore } from './analysesStore';

// CodeMirror needs a Range geometry in jsdom — see createTextEditor.test.ts.
// Only exercised here by the "New analysis" flow, which mounts AnalysisEditor.
beforeAll(() => {
  const emptyRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect;
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
});

afterEach(cleanup);

function artifact(id: string, overrides: Partial<AnalysisArtifact> = {}): AnalysisArtifact {
  return { id, title: `Title ${id}`, createdAt: Date.now(), sections: [], ...overrides };
}

function ref(sessionId: string | null, lineNumber = 1): SourceReference {
  return { lineNumber, endLine: null, label: 'ref', highlightType: 'Anchor', sessionId };
}

/** A hand-built `AnalysesStore` double — the panel is tested as a renderer
 *  over the store's public surface, not against the real store (that is
 *  `analysesStore.test.ts`'s job). */
function fakeStore(overrides: {
  list?: AnalysisArtifact[];
  labels?: ReadonlyMap<string, string>;
  error?: string | null;
  remove?: () => Promise<void>;
} = {}): AnalysesStore & { setList: (v: AnalysisArtifact[]) => void } {
  const [list, setList] = createSignal(overrides.list ?? []);
  const [loading] = createSignal(false);
  const [error] = createSignal<string | null>(overrides.error ?? null);
  const [labels] = createSignal<ReadonlyMap<string, string>>(overrides.labels ?? new Map());
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  return {
    list,
    loading,
    error,
    retry: vi.fn(),
    labels,
    selectedId,
    selected: () => list().find((a) => a.id === selectedId()),
    select: vi.fn((id: string | null) => setSelectedId(id)),
    open: vi.fn(() => Promise.resolve(artifact('x'))),
    publish: vi.fn(() => Promise.resolve(artifact('new'))),
    update: vi.fn(() => Promise.resolve(artifact('x'))),
    remove: vi.fn(overrides.remove ?? (() => Promise.resolve())),
    cursorReference: vi.fn(() => null),
    captureDraftSeed: vi.fn(),
    takeDraftSeed: vi.fn(() => null),
    jumpTo: vi.fn(),
    dispose: vi.fn(),
    setList: (v: AnalysisArtifact[]) => setList(v),
  };
}

describe('AnalysesPanel', () => {
  it('shows an empty-state message when there are no analyses', () => {
    render(() => <AnalysesPanel store={fakeStore()} />);
    expect(screen.getByText(/no analyses yet/i)).toBeTruthy();
  });

  it('groups artifacts by their first resolved session, newest first within the overall order', () => {
    const older = artifact('a1', { createdAt: 1_000, sections: [{ heading: 'h', body: 'b', references: [ref('s1')], severity: null }] });
    const newer = artifact('a2', { createdAt: 2_000, sections: [{ heading: 'h', body: 'b', references: [ref('s2')], severity: null }] });
    const unattributed = artifact('a3', { createdAt: 3_000, sections: [] });
    const store = fakeStore({
      list: [older, newer, unattributed],
      labels: new Map([['s1', 'app.log'], ['s2', 'kernel.log']]),
    });
    render(() => <AnalysesPanel store={store} />);

    // Newest-first grouping order: a3 (Unattributed) has no session, so its
    // sort position determines group order — a2's group (kernel.log) sorts
    // before a1's (app.log) since a2 is newer.
    const groupLabels = screen.getAllByRole('heading', { level: 5 }).map((el) => el.textContent);
    expect(groupLabels).toEqual(['Unattributed', 'kernel.log', 'app.log']);
    expect(screen.getByText('Title a1')).toBeTruthy();
    expect(screen.getByText('Title a2')).toBeTruthy();
    expect(screen.getByText('Title a3')).toBeTruthy();
  });

  it('applies the highest section severity as the card accent token', () => {
    const a = artifact('a1', {
      sections: [
        { heading: 'h1', body: 'b', references: [], severity: 'Warning' },
        { heading: 'h2', body: 'b', references: [], severity: 'Critical' },
      ],
    });
    render(() => <AnalysesPanel store={fakeStore({ list: [a] })} />);
    const card = screen.getByTestId('analysis-card');
    expect(card.style.getPropertyValue('--card-accent')).toBe('var(--danger)');
  });

  it('filters the list by title as the search field changes', () => {
    const store = fakeStore({ list: [artifact('a1', { title: 'Battery drain' }), artifact('a2', { title: 'ANR trace' })] });
    render(() => <AnalysesPanel store={store} />);
    const search = screen.getByRole('searchbox');
    fireEvent.input(search, { target: { value: 'battery' } });
    expect(screen.getByText('Battery drain')).toBeTruthy();
    expect(screen.queryByText('ANR trace')).toBeNull();
  });

  it('selecting a card opens the reader', async () => {
    const a = artifact('a1');
    const store = fakeStore({ list: [a] });
    render(() => <AnalysesPanel store={store} />);
    fireEvent.click(screen.getByText('Title a1'));
    expect(store.select).toHaveBeenCalledWith('a1');
    expect(await screen.findByTestId('analysis-reader')).toBeTruthy();
  });

  it('opens the reader when the selection is made outside the panel (the workspace index, an agent)', async () => {
    const store = fakeStore({ list: [artifact('a')] });
    render(() => <AnalysesPanel store={store} />);
    expect(screen.getByText(/title a/i)).toBeTruthy();

    store.select('a');

    await screen.findByRole('button', { name: /back/i });
    expect(screen.queryByTestId('analysis-card')).toBeNull();
  });

  it('"New analysis" captures the draft seed and opens the editor', () => {
    const store = fakeStore();
    render(() => <AnalysesPanel store={store} />);
    fireEvent.click(screen.getByRole('button', { name: /new analysis/i }));
    expect(store.captureDraftSeed).toHaveBeenCalled();
    expect(screen.getByTestId('analysis-editor')).toBeTruthy();
  });

  it('deleting a card needs a confirm step, then calls remove() without opening the reader', () => {
    const a = artifact('a1');
    const store = fakeStore({ list: [a] });
    render(() => <AnalysesPanel store={store} />);

    fireEvent.click(screen.getByTitle('Delete analysis'));
    expect(store.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Confirm'));
    expect(store.remove).toHaveBeenCalledWith('a1');
    expect(store.select).not.toHaveBeenCalled();
    expect(screen.queryByTestId('analysis-reader')).toBeNull();
  });

  it('Space on the card opens the reader, but Space on the delete button does not', () => {
    const store = fakeStore({ list: [artifact('a1')] });
    render(() => <AnalysesPanel store={store} />);

    const deleteButton = screen.getByTitle('Delete analysis');
    // The card's keydown handler used to preventDefault() Space even when the
    // nested button had focus, so the button could never be activated.
    fireEvent.keyDown(deleteButton, { key: ' ' });
    expect(store.select).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId('analysis-card'), { key: ' ' });
    expect(store.select).toHaveBeenCalledWith('a1');
  });
});

describe('AnalysesPanel — failures are visible', () => {
  it('renders the store error with a Retry instead of the empty state', () => {
    const store = fakeStore({ error: 'Error: bridge down' });
    render(() => <AnalysesPanel store={store} />);

    expect(screen.getByTestId('analyses-error').textContent).toContain('bridge down');
    expect(screen.queryByText(/no analyses yet/i)).toBeNull();

    fireEvent.click(screen.getByText('Retry'));
    expect(store.retry).toHaveBeenCalled();
  });

  it('surfaces a rejected delete instead of leaving an unhandled rejection', async () => {
    const store = fakeStore({
      list: [artifact('a1')],
      remove: () => Promise.reject(new Error('delete failed')),
    });
    render(() => <AnalysesPanel store={store} />);

    fireEvent.click(screen.getByTitle('Delete analysis'));
    fireEvent.click(screen.getByText('Confirm'));
    expect((await screen.findByTestId('analyses-action-error')).textContent).toContain('delete failed');
  });
});

describe('AnalysesPanel — reader mode state machine', () => {
  it('falls back to the list when the selected artifact is deleted out from under the reader', async () => {
    const a = artifact('a1');
    const store = fakeStore({ list: [a] });
    render(() => <AnalysesPanel store={store} />);

    fireEvent.click(screen.getByText('Title a1'));
    expect(await screen.findByTestId('analysis-reader')).toBeTruthy();

    // An `analysis-update` `deleted` drops it from the list; `selected()` goes
    // undefined and the reader used to stay up saying "Select an analysis".
    store.setList([]);
    expect(screen.queryByTestId('analysis-reader')).toBeNull();
    expect(screen.getByText(/no analyses yet/i)).toBeTruthy();
  });
});
