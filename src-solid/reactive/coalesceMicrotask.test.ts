import { describe, expect, it, vi } from 'vitest';
import { coalesceMicrotask } from './coalesceMicrotask';

describe('coalesceMicrotask', () => {
  it('does not call fn synchronously', () => {
    const fn = vi.fn();
    const schedule = coalesceMicrotask(fn);
    schedule();
    expect(fn).not.toHaveBeenCalled();
  });

  it('calls fn once after the microtask queue drains', async () => {
    const fn = vi.fn();
    const schedule = coalesceMicrotask(fn);
    schedule();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('coalesces a synchronous burst of calls into a single fn invocation', async () => {
    const fn = vi.fn();
    const schedule = coalesceMicrotask(fn);
    schedule();
    schedule();
    schedule();
    schedule();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('schedules a fresh call once the pending microtask has fired', async () => {
    const fn = vi.fn();
    const schedule = coalesceMicrotask(fn);

    schedule();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);

    schedule();
    schedule();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a call made from inside fn schedules a new microtask rather than being swallowed', async () => {
    let calls = 0;
    const schedule = coalesceMicrotask(() => {
      calls++;
      if (calls === 1) schedule();
    });
    schedule();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
  });
});
