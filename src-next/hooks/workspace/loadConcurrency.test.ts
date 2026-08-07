import { describe, it, expect, vi } from 'vitest';
import { runBoundedByKey } from './loadConcurrency';

describe('runBoundedByKey', () => {
  it('never runs more than `limit` tasks concurrently', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;

    await runBoundedByKey(
      items,
      (_item, i) => `unique-${i}`, // every task its own key — free to run concurrently
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 10));
        active--;
      },
      4,
    );

    expect(maxActive).toBeLessThanOrEqual(4);
    // Sanity: concurrency actually happened (not accidentally serialized).
    expect(maxActive).toBeGreaterThan(1);
  });

  it('never runs two same-key tasks concurrently, regardless of resolution order', async () => {
    const items = ['a1', 'a2', 'a3', 'b1', 'b2'];
    const keyOf = (item: string) => item[0]!; // 'a' or 'b'
    const activeByKey = new Map<string, number>();
    let sawOverlap = false;

    // Resolve out of order: later-submitted tasks finish first.
    const delays: Record<string, number> = { a1: 30, a2: 5, a3: 15, b1: 20, b2: 1 };

    await runBoundedByKey(
      items,
      (item) => keyOf(item),
      async (item) => {
        const key = keyOf(item);
        const n = (activeByKey.get(key) ?? 0) + 1;
        activeByKey.set(key, n);
        if (n > 1) sawOverlap = true;
        await new Promise((resolve) => setTimeout(resolve, delays[item]));
        activeByKey.set(key, (activeByKey.get(key) ?? 1) - 1);
      },
      4,
    );

    expect(sawOverlap).toBe(false);
  });

  it('resolves all tasks even when submitted and completed out of order', async () => {
    const items = [10, 20, 30, 40, 50];
    const seen: number[] = [];
    const delays = [5, 1, 4, 2, 3]; // deliberately non-monotonic completion order

    await runBoundedByKey(
      items,
      (_item, i) => `k${i}`,
      async (item, i) => {
        await new Promise((resolve) => setTimeout(resolve, delays[i]));
        seen.push(item);
      },
      4,
    );

    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("a task's rejection does not wedge later same-key tasks", async () => {
    const items = ['x1', 'x2', 'x3'];
    const ran: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runBoundedByKey(
      items,
      () => 'same-key',
      async (item) => {
        ran.push(item);
        if (item === 'x1') throw new Error('boom');
      },
      4,
    );

    expect(ran).toEqual(['x1', 'x2', 'x3']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('handles an empty item list', async () => {
    await expect(runBoundedByKey([], () => 'k', async () => {}, 4)).resolves.toBeUndefined();
  });

  it('runs everything sequentially when limit is 1', async () => {
    const items = [1, 2, 3];
    const order: number[] = [];

    await runBoundedByKey(
      items,
      (_item, i) => `k${i}`,
      async (item) => { order.push(item); },
      1,
    );

    expect(order).toEqual([1, 2, 3]);
  });
});
