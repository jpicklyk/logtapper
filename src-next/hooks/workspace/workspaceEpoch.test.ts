import { describe, it, expect } from 'vitest';
import { bumpWorkspaceEpoch, getWorkspaceEpoch } from './workspaceEpoch';

/**
 * Regression tests for the workspace-epoch guard (item
 * 6b9d644c-eff7-486c-982f-9034b3e7f84f — in-flight file load survives
 * workspace switch and lands in the new workspace).
 *
 * `epoch` is module-scope (singleton), so these tests assert relative
 * behaviour (strictly increasing, matches-after-bump) rather than fixed
 * absolute values — the counter carries state across every `it()` in this
 * file, by design (mirrors how the real singleton behaves across the app's
 * lifetime).
 */
describe('workspaceEpoch', () => {
  it('getWorkspaceEpoch reflects the value bumpWorkspaceEpoch just returned', () => {
    const bumped = bumpWorkspaceEpoch();
    expect(getWorkspaceEpoch()).toBe(bumped);
  });

  it('each bump strictly increases the epoch', () => {
    const first = bumpWorkspaceEpoch();
    const second = bumpWorkspaceEpoch();
    const third = bumpWorkspaceEpoch();
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('a value captured before a bump no longer matches the current epoch', () => {
    // Mirrors useFileSession.loadFile: capture epoch at load start, compare
    // at resolve time.
    const epochAtStart = getWorkspaceEpoch();
    bumpWorkspaceEpoch(); // simulates doClearPanes running mid-load
    expect(getWorkspaceEpoch()).not.toBe(epochAtStart);
  });

  it('restore-burst loads capture the epoch AFTER the bump and are not discarded', () => {
    // Mirrors the doClearPanes -> doLoadWorkspace(restoreWorkspace) sequence:
    // doClearPanes bumps the epoch synchronously and fully resolves before
    // the restore's own loadFile calls run, so each of them captures the
    // POST-bump value and must compare as fresh, not stale.
    bumpWorkspaceEpoch(); // doClearPanes teardown for the switch itself

    // Restore burst: several loadFile calls, each capturing "now".
    const restoreLoadEpochs = [getWorkspaceEpoch(), getWorkspaceEpoch(), getWorkspaceEpoch()];

    // No further teardown happens while these loads are in flight — each one
    // resolving later must still see a match.
    for (const captured of restoreLoadEpochs) {
      expect(captured).toBe(getWorkspaceEpoch());
    }
  });

  it('a load in flight during a NEXT switch (after the restore) is correctly discarded', () => {
    const postRestoreBump = bumpWorkspaceEpoch();
    const restoreLoadEpoch = getWorkspaceEpoch();
    expect(restoreLoadEpoch).toBe(postRestoreBump);

    // User triggers another switch while that load is still in flight.
    bumpWorkspaceEpoch();
    expect(getWorkspaceEpoch()).not.toBe(restoreLoadEpoch);
  });
});
