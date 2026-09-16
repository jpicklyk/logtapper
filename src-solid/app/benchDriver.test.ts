import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { installBenchApp, isBenchMode } from './benchDriver';
import type { BenchApp } from './benchDriver';
import type { AppActions } from './actions';
import type { LiveStreamStore } from '../stream';

type BenchGlobal = { __benchApp?: BenchApp };

function deps() {
  const actions = { openPath: vi.fn(() => Promise.resolve('s1')) } as unknown as AppActions;
  const stream = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    status: vi.fn(() => ({ phase: 'streaming', sessionId: 's1' })),
  } as unknown as LiveStreamStore;
  return { actions, stream };
}

afterEach(() => {
  delete (window as unknown as BenchGlobal).__benchApp;
});

describe('isBenchMode', () => {
  it('reads the query string', () => {
    expect(isBenchMode('?bench=1')).toBe(true);
    expect(isBenchMode('?other=1')).toBe(false);
    expect(isBenchMode('')).toBe(false);
  });
});

describe('installBenchApp', () => {
  it('publishes the window contract scripts/bench.md drives', async () => {
    const dispose = createRoot((d) => {
      installBenchApp(deps());
      return d;
    });

    const bench = (window as unknown as BenchGlobal).__benchApp;
    expect(bench).toBeTruthy();
    expect(await bench?.startStream('device-1')).toBe('s1');
    dispose();
  });

  it('clears the global on cleanup', () => {
    const dispose = createRoot((d) => {
      installBenchApp(deps());
      return d;
    });

    dispose();

    expect((window as unknown as BenchGlobal).__benchApp).toBeUndefined();
  });

  // Review A-L8: the cleanup used to `delete` unconditionally, so a torn-down
  // owner wiped whatever a *newer* install had just published.
  it('leaves a newer install alone when two overlap', () => {
    const disposeFirst = createRoot((d) => {
      installBenchApp(deps());
      return d;
    });
    const disposeSecond = createRoot((d) => {
      installBenchApp(deps());
      return d;
    });
    const newest = (window as unknown as BenchGlobal).__benchApp;

    disposeFirst();

    expect((window as unknown as BenchGlobal).__benchApp).toBe(newest);
    disposeSecond();
    expect((window as unknown as BenchGlobal).__benchApp).toBeUndefined();
  });
});
