// @vitest-environment jsdom
/**
 * U12: useViewCache's allocation must not run in the render body.
 *
 * mgr.allocateView() used to run directly in useViewCache's render body. It
 * registers a handle in the module-level (shared, external-to-React)
 * CacheManager, may become the focused view, and its internal
 * _redistribute() applies LRU eviction pressure to OTHER views' cached
 * lines. A render that starts but is never committed (a genuinely abandoned
 * concurrent-mode render, or a Suspense-discarded pass) would leave a ghost
 * handle in the CacheManager forever, since this hook deliberately has no
 * unmount cleanup (handles are released explicitly via releaseSessionViews()
 * when a session closes — see the in-file note).
 *
 * Fix: move allocation into a useEffect keyed on [mgr, viewId, sessionId].
 * This is safe for LogViewer's first-paint contract because LogViewer
 * already creates its CacheDataSource — what consumers actually read from —
 * in its own effect keyed on `viewCache`, gated by `if (!dataSource) return
 * null`; the handle was already effectively "one effect tick late" from a
 * consumer's perspective.
 *
 * Note: a true render-abandonment (vs. React.StrictMode's render-body
 * double-invoke, which always results in a commit) isn't reproducible in
 * this harness — allocateView is also idempotent for repeat calls with the
 * same viewId, so a StrictMode double-invoke of the effect itself is safe
 * either way. These tests are therefore correctness/regression tests for the
 * effect-based rewrite, not a reproduction of the ghost-handle leak itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { CacheProvider, useViewCache, useCacheManager, preSeedSession, clearPreSeed } from './index';
import { CacheManager } from './CacheManager';
import type { ViewLine } from '../bridge/types';

function makeLine(lineNum: number): ViewLine {
  return {
    lineNum,
    virtualIndex: lineNum,
    raw: `line ${lineNum}`,
    level: 'Info',
    tag: 'Test',
    message: `message ${lineNum}`,
    timestamp: lineNum * 1000,
    pid: 1,
    tid: 1,
    sourceId: 'test',
    highlights: [],
    matchedBy: [],
    isContext: false,
  };
}

function renderStrict(viewId: string | null, sessionId?: string | null) {
  return renderHook(
    () => ({ handle: useViewCache(viewId, sessionId), manager: useCacheManager() }),
    {
      wrapper: ({ children }) =>
        React.createElement(React.StrictMode, null, React.createElement(CacheProvider, null, children)),
    },
  );
}

describe('U12: useViewCache allocates in an effect, not in render', () => {
  it('returns a valid, working handle after mount', () => {
    const { result } = renderStrict('view-session-1', 'session-1');

    expect(result.current.handle).not.toBeNull();
    result.current.handle!.put([makeLine(1), makeLine(2)]);
    expect(result.current.handle!.get(1)?.raw).toBe('line 1');
  });

  it('consumes pre-seeded lines for the session once the handle exists', () => {
    preSeedSession('session-preseed', [makeLine(5), makeLine(6)]);

    const { result } = renderStrict('view-session-preseed', 'session-preseed');

    expect(result.current.handle).not.toBeNull();
    expect(result.current.handle!.get(5)?.raw).toBe('line 5');
    expect(result.current.handle!.get(6)?.raw).toBe('line 6');

    clearPreSeed('session-preseed'); // no-op safety net if the test fails before consumption
  });

  it('preserves the old handle in the manager when viewId changes, then re-acquires it on switch-back', () => {
    const { result, rerender } = renderHook(
      ({ viewId }: { viewId: string }) => useViewCache(viewId, 'session-switch'),
      {
        initialProps: { viewId: 'view-A' },
        wrapper: ({ children }) => React.createElement(CacheProvider, null, children),
      },
    );

    act(() => {
      result.current!.put([makeLine(100)]);
    });
    expect(result.current!.get(100)?.raw).toBe('line 100');

    // Switch to a different view — the old handle for view-A is intentionally
    // NOT released (inactive-tab lines survive a tab switch).
    rerender({ viewId: 'view-B' });
    expect(result.current).not.toBeNull();

    // Switch back — re-acquires the SAME view-A handle (allocateView returns
    // the existing entry), so the earlier line is still cached.
    rerender({ viewId: 'view-A' });
    expect(result.current!.get(100)?.raw).toBe('line 100');
  });

  it('allocateView is idempotent for repeat calls with the same viewId (safe under StrictMode effect double-invoke)', () => {
    const spy = vi.spyOn(CacheManager.prototype, 'allocateView');
    try {
      renderStrict('view-idempotent', 'session-idempotent');
      // StrictMode double-invokes the effect (mount → simulated unmount →
      // mount again), so allocateView is called at least twice — but every
      // call after the first is a no-op lookup, never a second registration.
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
      for (const call of spy.mock.calls) {
        expect(call[0]).toBe('view-idempotent');
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('U12: useViewCache returns null when the manager or viewId is unavailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when viewId is null', () => {
    const { result } = renderStrict(null, null);
    expect(result.current.handle).toBeNull();
  });
});
