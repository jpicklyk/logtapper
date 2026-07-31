// @vitest-environment jsdom
/**
 * Tests for useStateTracker's session:pre-load handling (U15).
 *
 * `session:pre-load` used to carry only `{ paneId }`; consumers resolved the
 * outgoing sessionId via `paneSessionMapRef`, which is one render behind at
 * exactly this point in the load sequence (see events/events.ts and
 * hooks/CLAUDE.md). The payload now carries `outgoingSessionId` resolved by
 * the emitter at emit time, so the consumer here should act on the payload
 * value directly rather than re-deriving it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { bus } from '../events/bus';

vi.mock('../bridge/events', () => ({
  onAdbTrackerUpdate: () => new Promise<() => void>(() => {}), // never resolves — no-op unlisten
}));

import { useStateTracker } from './useStateTracker';
import { TrackerProvider, useTrackerContext } from '../context/TrackerContext';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(TrackerProvider, null, children);
}

function setup() {
  return renderHook(
    () => {
      const actions = useStateTracker();
      const ctx = useTrackerContext();
      return { actions, ctx };
    },
    { wrapper },
  );
}

describe('useStateTracker — session:pre-load targeting', () => {
  beforeEach(() => {
    bus.all.clear();
  });

  it('clears only the outgoing session, using the emitted outgoingSessionId', () => {
    const { result } = setup();

    act(() => {
      result.current.ctx.setSessionUpdateCounts('session-a', () => ({ tracker1: 3 }));
      result.current.ctx.setSessionUpdateCounts('session-b', () => ({ tracker1: 7 }));
    });
    expect(result.current.ctx.dataBySession['session-a']).toBeDefined();
    expect(result.current.ctx.dataBySession['session-b']).toBeDefined();

    act(() => {
      bus.emit('session:pre-load', { paneId: 'pane-1', outgoingSessionId: 'session-a' });
    });

    expect(result.current.ctx.dataBySession['session-a']).toBeUndefined();
    expect(result.current.ctx.dataBySession['session-b']).toBeDefined();
  });

  it('clears nothing when outgoingSessionId is null (pane was empty)', () => {
    const { result } = setup();

    act(() => {
      result.current.ctx.setSessionUpdateCounts('session-a', () => ({ tracker1: 3 }));
    });

    act(() => {
      bus.emit('session:pre-load', { paneId: 'pane-1', outgoingSessionId: null });
    });

    expect(result.current.ctx.dataBySession['session-a']).toBeDefined();
  });
});
