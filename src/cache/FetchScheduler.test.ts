import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FetchScheduler } from './FetchScheduler';

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

  it('forceFetch bypasses velocity check', () => {
    const scheduler = new FetchScheduler({ velocityThreshold: 999 });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    scheduler.forceFetch(0, 500);
    expect(fetchFn).toHaveBeenCalledWith(0, 500);
  });

  it('includes prefetch lines in fetch range', () => {
    const scheduler = new FetchScheduler({
      prefetchLines: 200,
      velocityThreshold: 999, // Always "settled"
    });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    scheduler.reportScroll(500, 550, 10000);
    expect(fetchFn).toHaveBeenCalledWith(300, 450);
    // offset = max(0, 500 - 200) = 300
    // end = min(10000, 550 + 200) = 750
    // count = 750 - 300 = 450
  });

  it('clamps fetch range to [0, totalLines]', () => {
    const scheduler = new FetchScheduler({
      prefetchLines: 200,
      velocityThreshold: 999,
    });
    const fetchFn = vi.fn();
    scheduler.onFetch(fetchFn);

    scheduler.reportScroll(50, 100, 200);
    expect(fetchFn).toHaveBeenCalledWith(0, 200);
    // offset = max(0, 50 - 200) = 0
    // end = min(200, 100 + 200) = 200
    // count = 200 - 0 = 200
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
});
