// @vitest-environment jsdom
/**
 * U14: addToast's over-cap eviction must not mutate timersRef from inside the
 * setState updater.
 *
 * StrictMode double-invokes setState updaters. The eviction logic (drop the
 * oldest toast past MAX_TOASTS, clear its auto-dismiss timer, delete it from
 * timersRef) used to run inside the updater passed to setToasts. Fix:
 * pre-compute the eviction from toastsRef.current (a ref mirroring state,
 * synced at render time) and clear the evicted timer BEFORE calling setState,
 * so the updater only ever applies a pre-computed toast list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useToast } from './useToast';
import type { ToastItem } from '../ui';

function makeToast(id: string): ToastItem {
  return { id, title: `Toast ${id}`, message: `toast ${id}` };
}

function renderStrict() {
  return renderHook(() => useToast(), {
    wrapper: ({ children }) => React.createElement(React.StrictMode, null, children),
  });
}

describe('U14: addToast evicts over-cap toasts without impure setState updater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps the visible toast list at MAX_TOASTS (3), dropping the oldest', () => {
    const { result } = renderStrict();

    act(() => {
      result.current.addToast(makeToast('a'));
      result.current.addToast(makeToast('b'));
      result.current.addToast(makeToast('c'));
      result.current.addToast(makeToast('d'));
    });

    expect(result.current.toasts.map((t) => t.id)).toEqual(['b', 'c', 'd']);
  });

  it('dismissing a toast that was already evicted by the cap is a harmless no-op', () => {
    const { result } = renderStrict();

    act(() => {
      result.current.addToast(makeToast('a'));
      result.current.addToast(makeToast('b'));
      result.current.addToast(makeToast('c'));
      result.current.addToast(makeToast('d'));
    });

    // 'a' was evicted by the cap already — its timer should have been cleared,
    // not left dangling. Advancing all timers must not resurrect or crash on it.
    act(() => {
      result.current.dismissToast('a');
    });

    expect(result.current.toasts.map((t) => t.id)).toEqual(['b', 'c', 'd']);

    act(() => {
      vi.advanceTimersByTime(8000);
    });

    // All remaining toasts auto-dismiss on schedule; none linger because of a
    // stale/duplicated timer reference from the eviction.
    expect(result.current.toasts).toEqual([]);
  });

  it('adding one toast at a time never exceeds the cap, even under StrictMode double-render', () => {
    const { result } = renderStrict();

    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      act(() => {
        result.current.addToast(makeToast(id));
      });
      expect(result.current.toasts.length).toBeLessThanOrEqual(3);
    }

    expect(result.current.toasts.map((t) => t.id)).toEqual(['c', 'd', 'e']);
  });
});
