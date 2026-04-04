/**
 * Tests for ADB stream lifecycle invariants.
 *
 * These test the real state machine functions extracted from useStreamSession,
 * verifying ordering guarantees (channelActive=false before stop) and
 * state consistency across start/stop sequences.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { teardownStream, activateStream, type StreamRefs, type StreamDeps } from './streamStateMachine';

function createStreamLifecycle() {
  const refs: StreamRefs = {
    streamingSessionIdRef: { current: null },
    isStreamingRef: { current: false },
    channelActiveRef: { current: false },
  };

  const stopCalls: string[] = [];
  const startCalls: string[] = [];

  const stopAdbStream = vi.fn(async (sessionId: string) => {
    stopCalls.push(sessionId);
  });

  const deps: StreamDeps = { stopAdbStream };

  async function startStream(sessionId: string) {
    // Stop previous stream if active (mirrors useStreamSession.startStream)
    const prevSessionId = refs.streamingSessionIdRef.current;
    if (prevSessionId) {
      await teardownStream(refs, deps, prevSessionId);
    }

    refs.channelActiveRef.current = false; // reset before backend call
    // ... (backend call would happen here) ...
    activateStream(refs, sessionId);
    startCalls.push(sessionId);
  }

  async function stopStream() {
    const sessionId = refs.streamingSessionIdRef.current;
    if (!sessionId) return;
    await teardownStream(refs, deps, sessionId);
  }

  return { refs, startStream, stopStream, stopAdbStream, stopCalls, startCalls };
}

describe('ADB stream lifecycle', () => {
  let lifecycle: ReturnType<typeof createStreamLifecycle>;

  beforeEach(() => {
    lifecycle = createStreamLifecycle();
  });

  it('starting a stream sets active state', async () => {
    await lifecycle.startStream('session-1');
    expect(lifecycle.refs.streamingSessionIdRef.current).toBe('session-1');
    expect(lifecycle.refs.channelActiveRef.current).toBe(true);
    expect(lifecycle.refs.isStreamingRef.current).toBe(true);
  });

  it('stopping a stream clears active state', async () => {
    await lifecycle.startStream('session-1');
    await lifecycle.stopStream();
    expect(lifecycle.refs.streamingSessionIdRef.current).toBeNull();
    expect(lifecycle.refs.channelActiveRef.current).toBe(false);
    expect(lifecycle.refs.isStreamingRef.current).toBe(false);
  });

  it('starting a new stream stops the previous one first', async () => {
    await lifecycle.startStream('session-1');
    await lifecycle.startStream('session-2');

    // Previous stream must have been stopped
    expect(lifecycle.stopAdbStream).toHaveBeenCalledWith('session-1');
    expect(lifecycle.stopCalls).toEqual(['session-1']);

    // New stream is now active
    expect(lifecycle.refs.streamingSessionIdRef.current).toBe('session-2');
    expect(lifecycle.refs.channelActiveRef.current).toBe(true);
  });

  it('starting a stream when none is active does not call stop', async () => {
    await lifecycle.startStream('session-1');
    expect(lifecycle.stopAdbStream).not.toHaveBeenCalled();
  });

  it('stopping when no stream is active is a no-op', async () => {
    await lifecycle.stopStream();
    expect(lifecycle.stopAdbStream).not.toHaveBeenCalled();
    expect(lifecycle.refs.streamingSessionIdRef.current).toBeNull();
  });

  it('rapid start-stop-start maintains correct state', async () => {
    await lifecycle.startStream('session-1');
    await lifecycle.stopStream();
    await lifecycle.startStream('session-2');

    expect(lifecycle.stopCalls).toEqual(['session-1']);
    expect(lifecycle.refs.streamingSessionIdRef.current).toBe('session-2');
    expect(lifecycle.refs.channelActiveRef.current).toBe(true);
  });

  it('three consecutive starts stop each previous stream', async () => {
    await lifecycle.startStream('session-1');
    await lifecycle.startStream('session-2');
    await lifecycle.startStream('session-3');

    expect(lifecycle.stopCalls).toEqual(['session-1', 'session-2']);
    expect(lifecycle.startCalls).toEqual(['session-1', 'session-2', 'session-3']);
    expect(lifecycle.refs.streamingSessionIdRef.current).toBe('session-3');
  });

  it('channel is deactivated before stop is called', async () => {
    await lifecycle.startStream('session-1');

    // Verify the channel was active
    expect(lifecycle.refs.channelActiveRef.current).toBe(true);

    // Track channel state at the moment stop is called
    let channelWasActiveWhenStopping = true;
    lifecycle.stopAdbStream.mockImplementation(async () => {
      channelWasActiveWhenStopping = lifecycle.refs.channelActiveRef.current;
    });

    await lifecycle.startStream('session-2');

    // Channel must have been deactivated BEFORE stopAdbStream was called
    expect(channelWasActiveWhenStopping).toBe(false);
  });
});
