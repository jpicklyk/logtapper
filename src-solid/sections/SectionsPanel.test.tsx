/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { SectionsPanel } from './SectionsPanel';
import type { SectionsStore } from './sectionsStore';
import { GROUP_THRESHOLD } from '@fileinfo/sectionTree';
import type { SectionEntry } from '@fileinfo/sectionTree';

afterEach(cleanup);

/**
 * A hand-built `SectionsStore` double — the panel is tested as a pure
 * renderer over the store's public surface, not against the real store (that
 * is `sectionsStore.test.ts`'s job).
 */
function fakeStore(overrides: {
  sections?: SectionEntry[];
  isBugreportSession?: boolean;
  scanning?: boolean;
  activeIndex?: number;
  /** Pre-expanded group/parent keys — lets a test render an already-open group directly. */
  expanded?: readonly string[];
} = {}): SectionsStore {
  const [sections] = createSignal<SectionEntry[]>(overrides.sections ?? []);
  const [isBugreportSession] = createSignal(overrides.isBugreportSession ?? true);
  const [scanning] = createSignal(overrides.scanning ?? false);
  const [activeIndex] = createSignal(overrides.activeIndex ?? -1);
  const [metadata] = createSignal(null);
  const [notice] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set<string>(overrides.expanded ?? []));

  return {
    isBugreportSession,
    scanning,
    sections,
    metadata,
    activeIndex,
    isSelected: (name) => selected().has(name),
    selectionCount: () => selected().size,
    toggle: vi.fn((name: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    }),
    toggleGroup: vi.fn((names: readonly string[]) => {
      setSelected((prev) => {
        const all = names.every((n) => prev.has(n));
        const next = new Set(prev);
        for (const n of names) {
          if (all) next.delete(n);
          else next.add(n);
        }
        return next;
      });
    }),
    clearSelection: vi.fn(() => setSelected(new Set<string>())),
    isExpanded: (key) => expanded().has(key),
    toggleExpanded: vi.fn((key: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }),
    jumpTo: vi.fn(),
    notice,
    dispose: vi.fn(),
  };
}

const FIXTURE: SectionEntry[] = [
  { name: 'MEMORY INFO', startLine: 0, endLine: 9 },
  { name: 'DUMPSYS activity', startLine: 10, endLine: 30 },
  { name: 'DUMPSYS activity.child', startLine: 15, endLine: 20, parentIndex: 1 },
];

describe('SectionsPanel — empty and scanning states', () => {
  it('shows the non-bugreport empty state and no tree', () => {
    render(() => <SectionsPanel store={fakeStore({ isBugreportSession: false, sections: FIXTURE })} />);
    expect(screen.getByText(/sections apply to bugreports and dumpstates/i)).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('shows a scanning message and no tree while indexing', () => {
    render(() => <SectionsPanel store={fakeStore({ scanning: true, sections: [] })} />);
    expect(screen.getByText(/scanning sections/i)).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('shows an empty-sections message once scanning is done with none found', () => {
    render(() => <SectionsPanel store={fakeStore({ sections: [] })} />);
    expect(screen.getByText(/no sections found/i)).toBeTruthy();
  });
});

describe('SectionsPanel — tree rendering (reuses sectionTree.ts, not a copy)', () => {
  it('renders a single section, and a parent with its child once expanded', () => {
    const store = fakeStore({ sections: FIXTURE, activeIndex: 0 });
    render(() => <SectionsPanel store={store} />);

    expect(screen.getByText('MEMORY INFO')).toBeTruthy();
    expect(screen.getByText('DUMPSYS activity')).toBeTruthy();
    // The child is folded into the parent header until expanded.
    expect(screen.queryByText('DUMPSYS activity.child')).toBeNull();

    fireEvent.click(screen.getByText('DUMPSYS activity'));
    expect(screen.getByText('DUMPSYS activity.child')).toBeTruthy();
  });

  const groupedFixture = (): SectionEntry[] =>
    Array.from({ length: GROUP_THRESHOLD + 1 }, (_, i) => ({
      name: `SHOW MAP ${i}`,
      startLine: i * 10,
      endLine: i * 10 + 5,
    }));

  it('groups GROUP_THRESHOLD+ sections sharing a prefix, collapsed by default — proof this is the real sectionTree.ts', () => {
    render(() => <SectionsPanel store={fakeStore({ sections: groupedFixture() })} />);

    // Grouped: the prefix header shows with the real count/total, individual
    // members do not until expanded. GROUP_THRESHOLD is sectionTree.ts's own
    // exported constant — a local copy would need to happen to match it, but
    // could drift from it silently; importing it ties this test to whichever
    // value the real module actually uses.
    const header = screen.getByText('SHOW MAP').closest('button');
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain(String(GROUP_THRESHOLD + 1));
    expect(screen.queryByText('SHOW MAP 0')).toBeNull();
  });

  it('reveals a group’s members when it starts expanded', () => {
    render(() => (
      <SectionsPanel store={fakeStore({ sections: groupedFixture(), expanded: ['g-SHOW MAP '] })} />
    ));

    expect(screen.getByText('SHOW MAP 0')).toBeTruthy();
    expect(screen.getByText(`SHOW MAP ${GROUP_THRESHOLD}`)).toBeTruthy();
  });

  it('filters by name using the real filterSections', () => {
    render(() => <SectionsPanel store={fakeStore({ sections: FIXTURE })} />);
    fireEvent.input(screen.getByPlaceholderText(/filter sections/i), { target: { value: 'memory' } });

    expect(screen.getByText('MEMORY INFO')).toBeTruthy();
    expect(screen.queryByText('DUMPSYS activity')).toBeNull();
  });
});

describe('SectionsPanel — checkbox selection', () => {
  it('toggles a leaf checkbox through the store', () => {
    const store = fakeStore({ sections: FIXTURE });
    render(() => <SectionsPanel store={store} />);

    const checkbox = screen.getByLabelText('Filter to MEMORY INFO') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(store.toggle).toHaveBeenCalledWith('MEMORY INFO');
    expect(checkbox.checked).toBe(true);
  });

  it('shows the selection banner and clears via the Clear button', () => {
    const store = fakeStore({ sections: FIXTURE });
    render(() => <SectionsPanel store={store} />);

    fireEvent.click(screen.getByLabelText('Filter to MEMORY INFO'));
    expect(screen.getByText(/1 section filtered/i)).toBeTruthy();

    fireEvent.click(screen.getByText('Clear'));
    expect(store.clearSelection).toHaveBeenCalled();
    expect(screen.queryByText(/section filtered/i)).toBeNull();
  });

  it('a checkbox click does not also trigger a jump', () => {
    const store = fakeStore({ sections: FIXTURE });
    render(() => <SectionsPanel store={store} />);

    fireEvent.click(screen.getByLabelText('Filter to MEMORY INFO'));
    expect(store.jumpTo).not.toHaveBeenCalled();
  });
});

describe('SectionsPanel — keyboard', () => {
  function panel(): HTMLElement {
    return screen.getByTestId('sections-panel');
  }

  it('/ focuses the filter input', () => {
    render(() => <SectionsPanel store={fakeStore({ sections: FIXTURE })} />);
    fireEvent.keyDown(panel(), { key: '/' });
    expect(document.activeElement).toBe(screen.getByPlaceholderText(/filter sections/i));
  });

  it('ArrowDown moves focus onto the first row, Enter jumps a leaf', () => {
    const store = fakeStore({ sections: FIXTURE });
    render(() => <SectionsPanel store={store} />);

    fireEvent.keyDown(panel(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('MEMORY INFO').closest('button'));

    fireEvent.keyDown(panel(), { key: 'Enter' });
    expect(store.jumpTo).toHaveBeenCalledWith(FIXTURE[0]);
  });

  it('Enter on a group header toggles expand instead of jumping', () => {
    const store = fakeStore({ sections: FIXTURE });
    render(() => <SectionsPanel store={store} />);

    fireEvent.keyDown(panel(), { key: 'ArrowDown' }); // MEMORY INFO
    fireEvent.keyDown(panel(), { key: 'ArrowDown' }); // DUMPSYS activity (group header)
    fireEvent.keyDown(panel(), { key: 'Enter' });

    expect(store.jumpTo).not.toHaveBeenCalled();
    expect(store.toggleExpanded).toHaveBeenCalledWith('p-10');
  });

  it('Space toggles the focused row’s checkbox', () => {
    const store = fakeStore({ sections: FIXTURE });
    render(() => <SectionsPanel store={store} />);

    fireEvent.keyDown(panel(), { key: 'ArrowDown' });
    fireEvent.keyDown(panel(), { key: ' ' });

    expect(store.toggle).toHaveBeenCalledWith('MEMORY INFO');
  });

  it('does not hijack arrow keys while typing in the filter input', () => {
    const store = fakeStore({ sections: FIXTURE });
    render(() => <SectionsPanel store={store} />);
    const input = screen.getByPlaceholderText(/filter sections/i);
    input.focus();

    fireEvent.keyDown(panel(), { key: 'ArrowDown' });
    expect(store.jumpTo).not.toHaveBeenCalled();
  });
});
