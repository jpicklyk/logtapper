import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FetchScheduler } from './FetchScheduler';
import type { FetchRange } from './FetchScheduler';

describe('FetchScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires fetch immediately when velocity is low', () => {
    const scheduler = new FetchScheduler({ velocityThreshold: 5 });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    // Simulate slow scroll — small movement, large time gap
    scheduler.reportScroll(100, 150, 10000);
    // velocity is 0 on first call (no prior position)
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('calls callback with separate viewport and prefetch ranges', () => {
    const scheduler = new FetchScheduler({
      prefetchLines: 200,
      velocityThreshold: 999, // Always "settled"
    });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    scheduler.reportScroll(500, 550, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const [viewport, prefetch] = fetchFn.mock.calls[0] as [FetchRange, FetchRange];
    // Viewport is exactly the visible range
    expect(viewport).toEqual({ offset: 500, count: 51 });
    // Prefetch extends ahead (down direction on first call: firstVisible >= 0)
    // behind = floor(200 * 0.25) = 50, ahead = 200
    // pfStart = max(0, 500 - 50) = 450
    // pfEnd = min(10000, 550 + 200) = 750
    expect(prefetch).toEqual({ offset: 450, count: 300 });
  });

  it('defers fetch during fast scroll until settled', () => {
    const scheduler = new FetchScheduler({
      settleMs: 100,
      velocityThreshold: 0.01, // Very low threshold so most scrolls are "fast"
    });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    // First call — velocity is 0, so it fires immediately
    scheduler.reportScroll(0, 50, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Second call very quickly — high velocity
    vi.advanceTimersByTime(1);
    scheduler.reportScroll(500, 550, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1); // No new fetch — velocity too high

    // Wait for settle
    vi.advanceTimersByTime(100);
    expect(fetchFn).toHaveBeenCalledTimes(2); // Settled, fetch fired
  });

  it('cancels pending settle on new scroll', () => {
    const scheduler = new FetchScheduler({
      settleMs: 100,
      velocityThreshold: 0.01,
    });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    // First call at velocity 0 — immediate
    scheduler.reportScroll(0, 50, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Fast scroll
    vi.advanceTimersByTime(1);
    scheduler.reportScroll(500, 550, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Another fast scroll before settle
    vi.advanceTimersByTime(50);
    scheduler.reportScroll(1000, 1050, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // First timer would have fired at 100ms but was cancelled
    vi.advanceTimersByTime(50);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Second timer fires after 100ms from last scroll
    vi.advanceTimersByTime(50);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('forceFetch bypasses velocity check and dedup', () => {
    const scheduler = new FetchScheduler({ velocityThreshold: 999 });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    // Set up a pending range first
    scheduler.reportScroll(0, 50, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Report same scroll — dedup should skip
    scheduler.reportScroll(0, 50, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Force fetch — should fire even with same range
    scheduler.forceFetch();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('clamps fetch range to [0, totalLines]', () => {
    const scheduler = new FetchScheduler({
      prefetchLines: 200,
      velocityThreshold: 999,
    });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    scheduler.reportScroll(50, 100, 200);
    const [, prefetch] = fetchFn.mock.calls[0] as [FetchRange, FetchRange];
    // pfStart = max(0, 50 - 50) = 0  (behind = floor(200*0.25) = 50)
    // pfEnd = min(200, 100 + 200) = 200
    expect(prefetch.offset).toBe(0);
    expect(prefetch.offset + prefetch.count).toBeLessThanOrEqual(200);
  });

  it('dispose stops all timers and callbacks', () => {
    const scheduler = new FetchScheduler({
      settleMs: 100,
      velocityThreshold: 0.01,
    });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    // First call — immediate
    scheduler.reportScroll(0, 50, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Fast scroll — deferred
    vi.advanceTimersByTime(1);
    scheduler.reportScroll(500, 550, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Dispose before settle
    scheduler.dispose();
    vi.advanceTimersByTime(200);
    expect(fetchFn).toHaveBeenCalledTimes(1); // No additional fetch

    // Further reports are ignored
    scheduler.reportScroll(1000, 1050, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('isSettled reflects velocity state', () => {
    const scheduler = new FetchScheduler({ velocityThreshold: 5 });

    expect(scheduler.isSettled).toBe(true); // Initial velocity is 0
    expect(scheduler.velocity).toBe(0);
  });

  it('pendingFetch is null after execution', () => {
    const scheduler = new FetchScheduler({ velocityThreshold: 999 });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    expect(scheduler.pendingFetch).toBeNull();
    scheduler.reportScroll(100, 150, 10000);
    // After immediate execution, pendingFetch should be cleared
    expect(scheduler.pendingFetch).toBeNull();
  });

  it('computes direction correctly — scroll down vs up', () => {
    const scheduler = new FetchScheduler({
      prefetchLines: 200,
      velocityThreshold: 999,
    });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    // First scroll — position goes from 0 to 500 (down)
    scheduler.reportScroll(500, 550, 10000);
    const [, pfDown] = fetchFn.mock.calls[0] as [FetchRange, FetchRange];

    // Now scroll up
    scheduler.reportScroll(200, 250, 10000);
    const [, pfUp] = fetchFn.mock.calls[1] as [FetchRange, FetchRange];

    // Scrolling down: more lines ahead (below), less behind
    // pfDown: start = 500 - 50 = 450, end = 550 + 200 = 750
    expect(pfDown.offset).toBe(450);
    expect(pfDown.offset + pfDown.count).toBe(750);

    // Scrolling up: more lines ahead (above), less behind
    // pfUp: start = max(0, 200 - 200) = 0, end = 250 + 50 = 300
    expect(pfUp.offset).toBe(0);
    expect(pfUp.offset + pfUp.count).toBe(300);
  });

  it('dedup skips fetch when ranges unchanged', () => {
    const scheduler = new FetchScheduler({ velocityThreshold: 999 });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    scheduler.reportScroll(100, 150, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Same position — should be skipped (dedup)
    scheduler.reportScroll(100, 150, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Different position — should fire
    scheduler.reportScroll(200, 250, 10000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
