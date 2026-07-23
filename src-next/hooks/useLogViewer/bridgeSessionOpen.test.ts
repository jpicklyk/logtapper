import { describe, it, expect } from 'vitest';
import { planBridgeSessionOpen, type BridgeOpenInputs } from './bridgeSessionOpen';

/**
 * Tests for the bridge `session-opened` decision logic.
 *
 * The MCP bridge opens a backend session out-of-band; the frontend must surface
 * it as a tab WITHOUT re-invoking load_log_file and WITHOUT duplicating a tab for
 * a session that is already open (auto-permit reopen re-fires the event with the
 * same deterministic sessionId).
 */

function inputs(over: Partial<BridgeOpenInputs> = {}): BridgeOpenInputs {
  return {
    sessionId: 'sess-1',
    activeLogPaneId: null,
    storedFirstPaneId: null,
    defaultPaneId: 'primary',
    paneSessionMap: new Map(),
    isSessionOpen: () => false,
    ...over,
  };
}

describe('planBridgeSessionOpen', () => {
  it('skips when the payload has no sessionId', () => {
    expect(planBridgeSessionOpen(inputs({ sessionId: undefined }))).toEqual({
      kind: 'skip',
      reason: 'missing-session',
    });
    expect(planBridgeSessionOpen(inputs({ sessionId: null }))).toEqual({
      kind: 'skip',
      reason: 'missing-session',
    });
    expect(planBridgeSessionOpen(inputs({ sessionId: '' }))).toEqual({
      kind: 'skip',
      reason: 'missing-session',
    });
  });

  it('skips when the session is already open (reopen duplicate-tab guard)', () => {
    const plan = planBridgeSessionOpen(
      inputs({ sessionId: 'sess-1', isSessionOpen: (sid) => sid === 'sess-1' }),
    );
    expect(plan).toEqual({ kind: 'skip', reason: 'already-open' });
  });

  it('opens into the focused pane, replacing when the pane is empty', () => {
    const plan = planBridgeSessionOpen(
      inputs({ activeLogPaneId: 'pane-focused', paneSessionMap: new Map() }),
    );
    expect(plan).toEqual({
      kind: 'open',
      targetPaneId: 'pane-focused',
      isNewTab: false,
      previousSessionId: undefined,
    });
  });

  it('opens as a new tab when the target pane already holds a session', () => {
    const plan = planBridgeSessionOpen(
      inputs({
        activeLogPaneId: 'pane-focused',
        paneSessionMap: new Map([['pane-focused', 'other-session']]),
      }),
    );
    expect(plan).toEqual({
      kind: 'open',
      targetPaneId: 'pane-focused',
      isNewTab: true,
      previousSessionId: 'other-session',
    });
  });

  it('falls back active → stored-first → default for the target pane', () => {
    expect(planBridgeSessionOpen(inputs({ activeLogPaneId: 'a', storedFirstPaneId: 'b' })))
      .toMatchObject({ kind: 'open', targetPaneId: 'a' });
    expect(planBridgeSessionOpen(inputs({ activeLogPaneId: null, storedFirstPaneId: 'b' })))
      .toMatchObject({ kind: 'open', targetPaneId: 'b' });
    expect(planBridgeSessionOpen(inputs({ activeLogPaneId: null, storedFirstPaneId: null, defaultPaneId: 'primary' })))
      .toMatchObject({ kind: 'open', targetPaneId: 'primary' });
  });

  it('the already-open guard takes precedence over pane selection', () => {
    // Even with a valid focused pane, an already-open session must not re-open.
    const plan = planBridgeSessionOpen(
      inputs({
        activeLogPaneId: 'pane-focused',
        isSessionOpen: () => true,
      }),
    );
    expect(plan).toEqual({ kind: 'skip', reason: 'already-open' });
  });
});
