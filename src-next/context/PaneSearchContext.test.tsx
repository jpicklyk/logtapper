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
import React, { useEffect, type ReactNode } from 'react';
import { renderHook, render, act } from '@testing-library/react';
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

/**
 * U62: the provider's [sessionId] reset effect used to unconditionally null
 * effectiveLineNumsRef. PaneContent (a descendant) publishes the new
 * session's scoped lines via its own effect in the *same* commit that
 * sessionId changes — and React flushes child effects before parent
 * effects — so the provider's reset ran AFTER PaneContent's publish and
 * clobbered it back to null, letting jumpToMatch navigate outside the
 * filtered set until the next re-render. The fix drops the ref-nulling
 * from the provider's reset effect entirely; this test reproduces the real
 * child-before-parent effect ordering via an actual DOM render/rerender
 * (not renderHook) so the ordering is genuine, not simulated.
 */
describe('U62: effectiveLineNumsRef is not clobbered by a same-commit session switch', () => {
  beforeEach(() => {
    jumpToLineMock.mockClear();
    searchLogsMock.mockReset();
  });

  /** Mimics PaneContent: a descendant of PaneSearchProvider that publishes
   *  effectiveLineNums via an effect keyed on [value, sessionId]. */
  function Publisher({
    sessionId,
    effectiveLineNums,
    capture,
  }: {
    sessionId: string;
    effectiveLineNums: number[] | null;
    capture: { actions?: ReturnType<typeof usePaneSearchActions> };
  }) {
    const actions = usePaneSearchActions();
    capture.actions = actions;
    useEffect(() => {
      actions.setEffectiveLineNums(effectiveLineNums);
    }, [effectiveLineNums, sessionId, actions]);
    return null;
  }

  it('keeps the freshly published value across a session switch instead of being reset to null', async () => {
    const capture: { actions?: ReturnType<typeof usePaneSearchActions> } = {};

    const { rerender } = render(
      <PaneSearchProvider paneId="pane-1" sessionId="session-a">
        <Publisher sessionId="session-a" effectiveLineNums={[1, 2, 3]} capture={capture} />
      </PaneSearchProvider>,
    );

    // Session switches AND the new session's scoped lines are published in
    // the same commit — mirrors PaneContent recomputing effectiveLineNums
    // from the new session's already-available per-session filter state in
    // the same render pass that sessionId changes.
    searchLogsMock.mockResolvedValueOnce({
      totalMatches: 4,
      matchLineNums: [100, 150, 200, 250],
      byLevel: {},
      byTag: {},
    });

    rerender(
      <PaneSearchProvider paneId="pane-1" sessionId="session-b">
        <Publisher sessionId="session-b" effectiveLineNums={[100, 200]} capture={capture} />
      </PaneSearchProvider>,
    );

    await act(async () => {
      capture.actions!.setSearch({ text: 'x', isRegex: false, caseSensitive: false });
      await Promise.resolve();
      await Promise.resolve();
    });

    // setSearch's own jump-to-first-match already exercised jumpToLine once.
    jumpToLineMock.mockClear();

    act(() => {
      capture.actions!.jumpToMatch(1);
    });

    // If effectiveLineNumsRef had been nulled by the provider's reset
    // effect, jumpToMatch would treat all 4 matches as navigable and land
    // on 150 (matchLineNums[1]). Correctly scoped to [100, 200], the next
    // match after 100 is 200.
    expect(jumpToLineMock).toHaveBeenCalledWith(200, 'pane-1');
  });
});
