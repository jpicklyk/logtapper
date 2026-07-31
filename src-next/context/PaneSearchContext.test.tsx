// @vitest-environment jsdom
/**
 * U13: jumpToMatch must not double-fire its scroll side effect under
 * StrictMode.
 *
 * jumpToLineRef.current(...) used to be called from inside the setState
 * updater passed to jumpToMatch. StrictMode double-invokes setState updaters
 * (verified against a real React.StrictMode render — see useCenterTree's U9
 * tests for the harness probe), so the scroll side effect fired twice per
 * user-initiated "next match" / "previous match" action. Fix: compute the
 * next match index from stateRef.current outside the updater, call
 * jumpToLine exactly once, then setState with a pure updater.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import type { SearchSummary } from '../bridge/types';

const jumpToLineMock = vi.fn();
vi.mock('./ActionsContext', () => ({
  useActionsContext: () => ({ jumpToLine: jumpToLineMock }),
}));

const searchLogsMock = vi.fn();
vi.mock('../bridge/commands', () => ({
  searchLogs: (...args: unknown[]) => searchLogsMock(...args),
}));

vi.mock('../bridge/events', () => ({
  onSearchProgress: () => Promise.resolve(() => {}),
}));

import { PaneSearchProvider, usePaneSearch, usePaneSearchActions } from './PaneSearchContext';

function renderStrict() {
  return renderHook(
    () => ({ actions: usePaneSearchActions(), state: usePaneSearch() }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(PaneSearchProvider, { paneId: 'pane-1', sessionId: 'sess-1', children }),
        ),
    },
  );
}

const SUMMARY: SearchSummary = {
  totalMatches: 3,
  matchLineNums: [10, 20, 30],
  byLevel: {},
  byTag: {},
};

describe('U13: jumpToMatch does not double-fire jumpToLine under StrictMode', () => {
  beforeEach(() => {
    jumpToLineMock.mockClear();
    searchLogsMock.mockReset();
    searchLogsMock.mockResolvedValue(SUMMARY);
  });

  it('calls jumpToLine exactly once per jumpToMatch call', async () => {
    const { result } = renderStrict();

    await act(async () => {
      result.current.actions.setSearch({ text: 'x', isRegex: false, caseSensitive: false });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.summary?.matchLineNums).toEqual([10, 20, 30]);

    // setSearch's own jump-to-first-match already exercised jumpToLine once —
    // isolate jumpToMatch's own effect.
    jumpToLineMock.mockClear();

    act(() => {
      result.current.actions.jumpToMatch(1);
    });

    expect(jumpToLineMock).toHaveBeenCalledTimes(1);
  });

  it('advances currentMatchIndex correctly and wraps around', async () => {
    const { result } = renderStrict();

    await act(async () => {
      result.current.actions.setSearch({ text: 'x', isRegex: false, caseSensitive: false });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.matchIndex).toBe(0);

    act(() => {
      result.current.actions.jumpToMatch(1);
    });
    expect(result.current.state.matchIndex).toBe(1);

    act(() => {
      result.current.actions.jumpToMatch(1);
    });
    expect(result.current.state.matchIndex).toBe(2);

    // Wraps back to 0 past the last match.
    act(() => {
      result.current.actions.jumpToMatch(1);
    });
    expect(result.current.state.matchIndex).toBe(0);
  });

  it('is a no-op when there is no search summary yet', () => {
    const { result } = renderStrict();

    act(() => {
      result.current.actions.jumpToMatch(1);
    });

    expect(jumpToLineMock).not.toHaveBeenCalled();
    expect(result.current.state.matchIndex).toBe(0);
  });
});
