/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { AnalysisArtifact, SourceReference } from '@bridge/types';
import { AnalysisReader } from './AnalysisReader';
import type { AnalysesStore } from './analysesStore';

afterEach(cleanup);

function artifact(id: string, overrides: Partial<AnalysisArtifact> = {}): AnalysisArtifact {
  return { id, title: `Title ${id}`, createdAt: Date.now(), sections: [], ...overrides };
}

function ref(overrides: Partial<SourceReference> = {}): SourceReference {
  return { lineNumber: 42, endLine: null, label: 'Crash site', highlightType: 'Anchor', sessionId: 's1', ...overrides };
}

function fakeStore(overrides: {
  selected?: AnalysisArtifact;
  labels?: ReadonlyMap<string, string>;
} = {}): AnalysesStore {
  const [selected] = createSignal(overrides.selected);
  const labels = overrides.labels ?? new Map([['s1', 'app.log']]);

  return {
    list: () => (selected() ? [selected()!] : []),
    loading: () => false,
    error: () => null,
    labels: () => labels,
    selectedId: () => selected()?.id ?? null,
    selected,
    select: vi.fn(),
    open: vi.fn(() => Promise.resolve(artifact('x'))),
    publish: vi.fn(() => Promise.resolve(artifact('new'))),
    update: vi.fn(() => Promise.resolve(artifact('x'))),
    remove: vi.fn(() => Promise.resolve()),
    cursorReference: vi.fn(() => null),
    captureDraftSeed: vi.fn(),
    takeDraftSeed: vi.fn(() => null),
    jumpTo: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('AnalysisReader', () => {
  it('shows a placeholder when nothing is selected', () => {
    render(() => <AnalysisReader store={fakeStore()} onBack={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText(/select an analysis/i)).toBeTruthy();
  });

  it('renders every section of the selected artifact via AnalysisSectionView', () => {
    const a = artifact('a1', {
      sections: [
        { heading: 'Root cause', body: 'It crashed.', references: [], severity: 'Error' },
        { heading: 'Recommendation', body: 'Fix it.', references: [], severity: null },
      ],
    });
    render(() => <AnalysisReader store={fakeStore({ selected: a })} onBack={vi.fn()} onEdit={vi.fn()} />);
    expect(screen.getByText('Root cause')).toBeTruthy();
    expect(screen.getByText('Recommendation')).toBeTruthy();
  });

  it('resolves a reference to an open session and clicking its chip jumps through the store, with a range select', () => {
    const a = artifact('a1', {
      sections: [{ heading: 'Root cause', body: 'It crashed.', references: [ref({ endLine: 50 })], severity: null }],
    });
    const store = fakeStore({ selected: a, labels: new Map([['s1', 'app.log']]) });
    render(() => <AnalysisReader store={store} onBack={vi.fn()} onEdit={vi.fn()} />);

    const chip = screen.getByText('L42–50').closest('button') as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    expect(store.jumpTo).toHaveBeenCalledWith({ sessionId: 's1', line: 42, endLine: 50 });
  });

  it('marks an unresolved reference (unknown session) disabled and does not jump on click', () => {
    const a = artifact('a1', {
      sections: [{ heading: 'Root cause', body: 'It crashed.', references: [ref({ sessionId: 'gone' })], severity: null }],
    });
    const store = fakeStore({ selected: a, labels: new Map() });
    render(() => <AnalysisReader store={store} onBack={vi.fn()} onEdit={vi.fn()} />);

    const chip = screen.getByText('L42').closest('button') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    fireEvent.click(chip);
    expect(store.jumpTo).not.toHaveBeenCalled();
  });

  it('a line reference mentioned in the markdown body is also clickable', () => {
    const a = artifact('a1', {
      sections: [{ heading: 'Root cause', body: 'See L42 for details.', references: [ref()], severity: null }],
    });
    const store = fakeStore({ selected: a });
    render(() => <AnalysisReader store={store} onBack={vi.fn()} onEdit={vi.fn()} />);

    const anchors = screen.getAllByText('L42');
    // One in the chip row, one inline in the rendered markdown prose.
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(anchors[anchors.length - 1]);
    expect(store.jumpTo).toHaveBeenCalledWith({ sessionId: 's1', line: 42, endLine: null });
  });

  it('Back and Edit route to the corresponding callbacks', () => {
    const onBack = vi.fn();
    const onEdit = vi.fn();
    render(() => <AnalysisReader store={fakeStore({ selected: artifact('a1') })} onBack={onBack} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
