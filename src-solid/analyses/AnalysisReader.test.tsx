/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { AnalysisArtifact, AnonymizerMode, SourceReference } from '@bridge/types';
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
  error?: string | null;
  anonymizerMode?: () => Promise<AnonymizerMode>;
  copyMarkdown?: () => Promise<void>;
} = {}): AnalysesStore {
  const [selected] = createSignal(overrides.selected);
  const labels = overrides.labels ?? new Map([['s1', 'app.log']]);

  return {
    list: () => (selected() ? [selected()!] : []),
    loading: () => false,
    error: () => overrides.error ?? null,
    retry: vi.fn(),
    labels: () => labels,
    selectedId: () => selected()?.id ?? null,
    selected,
    select: vi.fn(),
    open: vi.fn(() => Promise.resolve(artifact('x'))),
    publish: vi.fn(() => Promise.resolve(artifact('new'))),
    update: vi.fn(() => Promise.resolve(artifact('x'))),
    remove: vi.fn(() => Promise.resolve()),
    exportMarkdown: vi.fn(() => Promise.resolve()),
    copyMarkdown: vi.fn(overrides.copyMarkdown ?? (() => Promise.resolve())),
    anonymizerMode: vi.fn(overrides.anonymizerMode ?? (() => Promise.resolve('external' as const))),
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

describe('AnalysisReader — export row', () => {
  const mount = (store: AnalysesStore, exportOpen?: boolean) =>
    render(() => <AnalysisReader store={store} exportOpen={exportOpen} onBack={vi.fn()} onEdit={vi.fn()} />);

  it('is collapsed by default and Export toggles it, fetching the anonymizer mode on open', async () => {
    const store = fakeStore({ selected: artifact('a1') });
    mount(store);
    expect(screen.queryByTestId('analysis-export-options')).toBeNull();
    expect(store.anonymizerMode).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    expect(screen.getByTestId('analysis-export-options')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('analysis-export-mode').textContent).toBe('External — log lines will be anonymized'),
    );

    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    expect(screen.queryByTestId('analysis-export-options')).toBeNull();
  });

  it('mounts expanded when exportOpen is set (the list row path)', () => {
    mount(fakeStore({ selected: artifact('a1') }), true);
    expect(screen.getByTestId('analysis-export-options')).toBeTruthy();
  });

  it.each<[AnonymizerMode, string]>([
    ['all', 'All — log lines will be anonymized'],
    ['none', 'None — exported raw'],
  ])('names mode %s in the status line', async (mode, text) => {
    mount(fakeStore({ selected: artifact('a1'), anonymizerMode: () => Promise.resolve(mode) }), true);
    await waitFor(() => expect(screen.getByTestId('analysis-export-mode').textContent).toBe(text));
  });

  it('reports an unreadable mode instead of guessing', async () => {
    mount(fakeStore({ selected: artifact('a1'), anonymizerMode: () => Promise.reject(new Error('boom')) }), true);
    await waitFor(() =>
      expect(screen.getByTestId('analysis-export-mode').textContent).toBe('Anonymizer mode unavailable'),
    );
  });

  it('Save as… passes the artifact id and the (clamped) context lines to the store', () => {
    const store = fakeStore({ selected: artifact('a1') });
    mount(store, true);
    const input = screen.getByLabelText(/context lines/i) as HTMLInputElement;
    fireEvent.input(input, { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: /save as/i }));
    expect(store.exportMarkdown).toHaveBeenCalledWith('a1', { contextLines: 10 });
  });

  it('Copy calls copyMarkdown and shows a transient "Copied!"', async () => {
    vi.useFakeTimers();
    try {
      const store = fakeStore({ selected: artifact('a1') });
      mount(store, true);
      fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
      expect(store.copyMarkdown).toHaveBeenCalledWith('a1', { contextLines: 2 });

      // Flush the copy promise's `.finally` without advancing the clock.
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByText('Copied!')).toBeTruthy();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(screen.queryByText('Copied!')).toBeNull();
      expect(screen.getByRole('button', { name: /^copy$/i })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed copy leaves the store error visible in the row and never says "Copied!"', async () => {
    const store = fakeStore({
      selected: artifact('a1'),
      error: 'Failed to render',
      copyMarkdown: () => Promise.resolve(),
    });
    mount(store, true);
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }));
    await waitFor(() => expect(screen.getByTestId('analysis-export-error').textContent).toContain('Failed to render'));
    expect(screen.queryByText('Copied!')).toBeNull();
  });
});
