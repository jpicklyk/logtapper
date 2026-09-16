/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { AnalysisArtifact } from '@bridge/types';
import { AnalysesIndex } from './AnalysesIndex';
import type { AnalysesStore } from './analysesStore';

afterEach(cleanup);

function artifact(id: string, overrides: Partial<AnalysisArtifact> = {}): AnalysisArtifact {
  return { id, title: `Analysis ${id}`, createdAt: 1_000, sections: [], ...overrides };
}

function fakeStore(list: AnalysisArtifact[], labels = new Map<string, string>()): AnalysesStore {
  const [items] = createSignal(list);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  return {
    list: items,
    loading: () => false,
    error: () => null,
    retry: vi.fn(),
    labels: () => labels,
    selectedId,
    selected: () => items().find((a) => a.id === selectedId()),
    select: vi.fn((id: string | null) => setSelectedId(id)),
    open: vi.fn(() => Promise.resolve(artifact('x'))),
    publish: vi.fn(() => Promise.resolve(artifact('new'))),
    update: vi.fn(() => Promise.resolve(artifact('x'))),
    remove: vi.fn(() => Promise.resolve()),
    cursorReference: vi.fn(() => null),
    captureDraftSeed: vi.fn(),
    takeDraftSeed: vi.fn(() => null),
    jumpTo: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AnalysesStore;
}

describe('AnalysesIndex', () => {
  it('shows an empty message with no analyses', () => {
    render(() => <AnalysesIndex store={fakeStore([])} />);
    expect(screen.getByText(/no analyses in this workspace yet/i)).toBeTruthy();
    expect(screen.queryAllByTestId('analyses-index-row')).toHaveLength(0);
  });

  it('lists artifacts newest first with their session label', () => {
    const labels = new Map([['s1', 'bugreport.log']]);
    const older = artifact('old', { createdAt: 1_000, sessionId: 's1' });
    const newer = artifact('new', {
      createdAt: 5_000,
      sections: [
        {
          heading: 'h',
          body: '',
          severity: null,
          references: [{ lineNumber: 3, endLine: null, label: 'ref', highlightType: 'Anchor', sessionId: 's1' }],
        },
      ] as never,
    });
    render(() => <AnalysesIndex store={fakeStore([older, newer], labels)} />);

    const rows = screen.getAllByTestId('analyses-index-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Analysis new'),
      expect.stringContaining('Analysis old'),
    ]);
    // Both resolve their session: the first through a section reference, the
    // second through the artifact-level sessionId fallback.
    expect(rows[0]!.textContent).toContain('bugreport.log');
    expect(rows[1]!.textContent).toContain('bugreport.log');
  });

  it('a click selects the artifact in the store, reports it through onOpen, and marks the row current', () => {
    const store = fakeStore([artifact('a'), artifact('b')]);
    const onOpen = vi.fn();
    render(() => <AnalysesIndex store={store} onOpen={onOpen} />);

    const [rowA] = screen.getAllByTestId('analyses-index-row');
    fireEvent.click(rowA!);

    expect(store.select).toHaveBeenCalledWith('a');
    expect(onOpen).toHaveBeenCalledWith('a');
    expect(rowA!.getAttribute('aria-current')).toBe('true');
  });
});
