/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { Bookmark } from '@bridge/types';
import type { SessionStore } from '../app/index';
import { BookmarksPanel } from './BookmarksPanel';
import type { BookmarksStore, CategoryGroup } from './bookmarksStore';

afterEach(cleanup);

function bookmark(id: string, overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id,
    sessionId: 's1',
    lineNumber: 10,
    label: `Bookmark ${id}`,
    note: '',
    createdBy: 'User',
    createdAt: Date.now(),
    ...overrides,
  };
}

function fakeSessions(focusedId: string | null): SessionStore {
  return { focusedId: () => focusedId } as unknown as SessionStore;
}

/** A hand-built `BookmarksStore` double — the panel is tested as a renderer
 *  over the store's public surface, not against the real store (that is
 *  `bookmarksStore.test.ts`'s job). */
function fakeStore(overrides: { groups?: CategoryGroup[]; loading?: boolean } = {}): BookmarksStore & {
  jumpTo: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  exportMarkdown: ReturnType<typeof vi.fn>;
} {
  const groups = overrides.groups ?? [];
  const all = groups.flatMap((g) => g.bookmarks);
  return {
    list: () => all,
    loading: () => overrides.loading ?? false,
    categories: () => groups,
    create: vi.fn(() => Promise.resolve(bookmark('new'))),
    update: vi.fn(() => Promise.resolve(bookmark('x'))),
    remove: vi.fn(() => Promise.resolve()),
    exportMarkdown: vi.fn(() => '# Bookmark Timeline'),
    jumpTo: vi.fn((_b: Bookmark) => undefined),
    cursorLine: vi.fn(() => 5),
    dispose: vi.fn(),
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

describe('BookmarksPanel', () => {
  it('shows an empty-state message when there is no focused session', () => {
    render(() => <BookmarksPanel store={fakeStore()} sessions={fakeSessions(null)} />);
    expect(screen.getByText(/no session loaded/i)).toBeTruthy();
  });

  it('shows an empty-state message when the focused session has no bookmarks', () => {
    render(() => <BookmarksPanel store={fakeStore()} sessions={fakeSessions('s1')} />);
    expect(screen.getByText(/no bookmarks yet/i)).toBeTruthy();
  });

  it('groups bookmarks by category with a per-group count', () => {
    const groups: CategoryGroup[] = [
      { id: 'error', label: 'Errors', count: 2, bookmarks: [bookmark('b1'), bookmark('b2')] },
      { id: 'timing', label: 'Timing', count: 1, bookmarks: [bookmark('b3')] },
    ];
    render(() => <BookmarksPanel store={fakeStore({ groups })} sessions={fakeSessions('s1')} />);
    const headings = screen.getAllByRole('heading', { level: 5 }).map((el) => el.textContent);
    expect(headings).toEqual(['Errors 2', 'Timing 1']);
    expect(screen.getByText('3')).toBeTruthy(); // header total count
  });

  it('renders a CallerBadge adapted from the bookmark\'s createdBy', () => {
    const groups: CategoryGroup[] = [
      { id: 'custom', label: 'Other', count: 2, bookmarks: [bookmark('b1', { createdBy: 'User' }), bookmark('b2', { createdBy: 'Agent' })] },
    ];
    render(() => <BookmarksPanel store={fakeStore({ groups })} sessions={fakeSessions('s1')} />);
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
  });

  it('clicking a row calls store.jumpTo with that bookmark', () => {
    const b = bookmark('b1', { sessionId: 's1', lineNumber: 41, lineNumberEnd: 45 });
    const groups: CategoryGroup[] = [{ id: 'custom', label: 'Other', count: 1, bookmarks: [b] }];
    const store = fakeStore({ groups });
    render(() => <BookmarksPanel store={store} sessions={fakeSessions('s1')} />);
    fireEvent.click(screen.getByTestId('bookmark-row'));
    expect(store.jumpTo).toHaveBeenCalledWith(b);
  });

  it('displays the range line indicator for a multi-line bookmark', () => {
    const b = bookmark('b1', { lineNumber: 41, lineNumberEnd: 45 });
    const groups: CategoryGroup[] = [{ id: 'custom', label: 'Other', count: 1, bookmarks: [b] }];
    render(() => <BookmarksPanel store={fakeStore({ groups })} sessions={fakeSessions('s1')} />);
    expect(screen.getByText('L42–46')).toBeTruthy();
  });

  it('"Export markdown" copies the store\'s markdown to the clipboard', async () => {
    const groups: CategoryGroup[] = [{ id: 'custom', label: 'Other', count: 1, bookmarks: [bookmark('b1')] }];
    const store = fakeStore({ groups });
    render(() => <BookmarksPanel store={store} sessions={fakeSessions('s1')} />);
    fireEvent.click(screen.getByTitle(/copy bookmarks as markdown/i));
    expect(store.exportMarkdown).toHaveBeenCalledWith('s1');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Bookmark Timeline');
    expect(await screen.findByText('Copied!')).toBeTruthy();
  });

  it('"Bookmark selection" opens the create dialog pre-filled from store.cursorLine', () => {
    const store = fakeStore();
    render(() => <BookmarksPanel store={store} sessions={fakeSessions('s1')} />);
    fireEvent.click(screen.getByText('Bookmark selection'));
    expect(store.cursorLine).toHaveBeenCalledWith('s1');
    expect(screen.getByText('Bookmark Line 6')).toBeTruthy(); // cursorLine() = 5 → "Line 6" (1-based)
  });

  it('editing a label calls store.update with the new label', async () => {
    const b = bookmark('b1', { label: 'Old label' });
    const groups: CategoryGroup[] = [{ id: 'custom', label: 'Other', count: 1, bookmarks: [b] }];
    const store = fakeStore({ groups });
    render(() => <BookmarksPanel store={store} sessions={fakeSessions('s1')} />);
    fireEvent.dblClick(screen.getByText('Old label'));
    const input = screen.getByDisplayValue('Old label') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'New label' } });
    fireEvent.blur(input);
    expect(store.update).toHaveBeenCalledWith('b1', { label: 'New label' });
  });

  it('deleting requires a confirm click', () => {
    const b = bookmark('b1');
    const groups: CategoryGroup[] = [{ id: 'custom', label: 'Other', count: 1, bookmarks: [b] }];
    const store = fakeStore({ groups });
    render(() => <BookmarksPanel store={store} sessions={fakeSessions('s1')} />);
    fireEvent.click(screen.getByTitle('Delete bookmark'));
    expect(store.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm'));
    expect(store.remove).toHaveBeenCalledWith('b1');
  });
});
