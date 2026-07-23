import { describe, it, expect } from 'vitest';
import { genKeyFor } from './loadGeneration';

/**
 * Regression tests for the load-cancellation generation guard.
 *
 * `loadFile` claims a generation when it starts and re-checks it when the
 * `load_log_file` IPC returns. A stale generation means the load was superseded,
 * so the result is discarded *and* the backend session it created is closed.
 *
 * The guard was keyed purely by pane. Startup restore fires one `loadFile` per
 * stored tab without awaiting, so two tabs in the same pane claimed the same
 * key: the second bumped the generation, and when the first returned it saw a
 * mismatch and destroyed its own session. Because the restore loop runs
 * active-tab-first, the file under investigation was always the casualty — and
 * opening a multi-session workspace stacks its sessions as tabs in one pane, so
 * this was the normal configuration, not an edge case.
 */
describe('genKeyFor', () => {
  it('claims the pane for a fresh open with no target tab', () => {
    expect(genKeyFor('primary')).toBe('primary');
    expect(genKeyFor('primary', undefined)).toBe('primary');
  });

  it('claims the tab when a load targets an existing tab', () => {
    const key = genKeyFor('primary', 'tab-a');
    expect(key).not.toBe('primary');
    expect(key).toContain('primary');
    expect(key).toContain('tab-a');
  });

  it('gives sibling tabs in the same pane distinct keys', () => {
    // The core regression: these two must not collide.
    expect(genKeyFor('primary', 'tab-a')).not.toBe(genKeyFor('primary', 'tab-b'));
  });

  it('gives the same tab id in different panes distinct keys', () => {
    expect(genKeyFor('pane-1', 'tab-a')).not.toBe(genKeyFor('pane-2', 'tab-a'));
  });

  it('is stable for the same inputs', () => {
    expect(genKeyFor('primary', 'tab-a')).toBe(genKeyFor('primary', 'tab-a'));
    expect(genKeyFor('primary')).toBe(genKeyFor('primary'));
  });

  it('does not collide with pane ids containing ordinary separators', () => {
    // Real pane and tab ids are slugs or UUIDs. A composite key must not be
    // reachable by any realistic single-argument call.
    const composite = genKeyFor('primary', 'tab-a');
    for (const paneId of ['primary-tab-a', 'primary:tab-a', 'primary_tab-a', 'primary/tab-a', 'primarytab-a']) {
      expect(genKeyFor(paneId)).not.toBe(composite);
    }
  });

  it('separates with a character that cannot occur in an id', () => {
    // NUL is the guarantee the collision-freedom above rests on.
    const key = genKeyFor('primary', 'tab-a');
    expect(key.charCodeAt('primary'.length)).toBe(0);
  });
});

describe('restore generation semantics', () => {
  /** Mirrors the claim/check cycle in loadFile against a shared generation map. */
  function simulate(loads: Array<{ paneId: string; tabId?: string }>) {
    const gens = new Map<string, number>();
    const claimed = loads.map(({ paneId, tabId }) => {
      const key = genKeyFor(paneId, tabId);
      const gen = (gens.get(key) ?? 0) + 1;
      gens.set(key, gen);
      return { key, gen };
    });
    // Every load resolves after all have been initiated — the un-awaited case.
    return claimed.map(({ key, gen }) => gens.get(key) === gen);
  }

  it('keeps every session when restoring sibling tabs into one pane', () => {
    const survived = simulate([
      { paneId: 'primary', tabId: 'tab-active' },
      { paneId: 'primary', tabId: 'tab-second' },
    ]);
    expect(survived).toEqual([true, true]);
  });

  it('keeps every session when restoring three tabs into one pane', () => {
    const survived = simulate([
      { paneId: 'primary', tabId: 'a' },
      { paneId: 'primary', tabId: 'b' },
      { paneId: 'primary', tabId: 'c' },
    ]);
    expect(survived).toEqual([true, true, true]);
  });

  it('still cancels a superseded load into the same tab', () => {
    // The guard's original purpose: a replacement load into one tab wins.
    const survived = simulate([
      { paneId: 'primary', tabId: 'tab-a' },
      { paneId: 'primary', tabId: 'tab-a' },
    ]);
    expect(survived).toEqual([false, true]);
  });

  it('still cancels a superseded fresh open into the same pane', () => {
    const survived = simulate([{ paneId: 'primary' }, { paneId: 'primary' }]);
    expect(survived).toEqual([false, true]);
  });

  it('reproduces the old defect when keyed by pane alone', () => {
    // Demonstrates what the fix changed: dropping the tab from the key makes
    // the active tab lose, which is exactly the reported symptom.
    const gens = new Map<string, number>();
    const claimed = [
      { paneId: 'primary', tabId: 'tab-active' },
      { paneId: 'primary', tabId: 'tab-second' },
    ].map(({ paneId }) => {
      const gen = (gens.get(paneId) ?? 0) + 1;
      gens.set(paneId, gen);
      return { key: paneId, gen };
    });
    const survived = claimed.map(({ key, gen }) => gens.get(key) === gen);
    expect(survived).toEqual([false, true]);
  });
});
