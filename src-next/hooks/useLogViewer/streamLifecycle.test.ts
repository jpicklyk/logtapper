/**
 * Tests for ADB stream lifecycle invariants.
 *
 * These test the state machine contract without Tauri IPC by simulating
 * the ref-based state transitions that useStreamSession manages.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulate the ref-based state that useStreamSession tracks.
interface StreamState {
  streamingSessionId: string | null;
  channelActive: boolean;
  isStreaming: boolean;
}

// Simulate the stream lifecycle operations extracted from useStreamSession.
function createStreamLifecycle() {
  const state: StreamState = {
    streamingSessionId: null,
    channelActive: false,
    isStreaming: false,
  };

  const stopCalls: string[] = [];
  const startCalls: string[] = [];

  const stopAdbStream = vi.fn(async (sessionId: string) => {
    stopCalls.push(sessionId);
  });

  async function startStream(sessionId: string) {
    // Mirrors useStreamSession.startStream logic:
    // 1. Stop previous stream if active
    const prevSessionId = state.streamingSessionId;
    if (prevSessionId) {
      state.channelActive = false;
      await stopAdbStream(prevSessionId);
      state.isStreaming = false;
      state.streamingSessionId = null;
    }

    // 2. Start new stream
    state.channelActive = false; // reset before backend call
    // ... (backend call would happen here) ...
    state.channelActive = true;
    state.isStreaming = true;
    state.streamingSessionId = sessionId;
    startCalls.push(sessionId);
  }

  async function stopStream() {
    const sessionId = state.streamingSessionId;
    if (!sessionId) return;
    state.channelActive = false;
    await stopAdbStream(sessionId);
    state.isStreaming = false;
    state.streamingSessionId = null;
  }

  return { state, startStream, stopStream, stopAdbStream, stopCalls, startCalls };
}

describe('ADB stream lifecycle', () => {
  let lifecycle: ReturnType<typeof createStreamLifecycle>;

  beforeEach(() => {
    lifecycle = createStreamLifecycle();
  });

  it('starting a stream sets active state', async () => {
    await lifecycle.startStream('session-1');
    expect(lifecycle.state.streamingSessionId).toBe('session-1');
    expect(lifecycle.state.channelActive).toBe(true);
    expect(lifecycle.state.isStreaming).toBe(true);
  });

  it('stopping a stream clears active state', async () => {
    await lifecycle.startStream('session-1');
    await lifecycle.stopStream();
    expect(lifecycle.state.streamingSessionId).toBeNull();
    expect(lifecycle.state.channelActive).toBe(false);
    expect(lifecycle.state.isStreaming).toBe(false);
  });

  it('starting a new stream stops the previous one first', async () => {
    await lifecycle.startStream('session-1');
    await lifecycle.startStream('session-2');

    // Previous stream must have been stopped
    expect(lifecycle.stopAdbStream).toHaveBeenCalledWith('session-1');
    expect(lifecycle.stopCalls).toEqual(['session-1']);

    // New stream is now active
    expect(lifecycle.state.streamingSessionId).toBe('session-2');
    expect(lifecycle.state.channelActive).toBe(true);
  });

  it('starting a stream when none is active does not call stop', async () => {
    await lifecycle.startStream('session-1');
    expect(lifecycle.stopAdbStream).not.toHaveBeenCalled();
  });

  it('stopping when no stream is active is a no-op', async () => {
    await lifecycle.stopStream();
    expect(lifecycle.stopAdbStream).not.toHaveBeenCalled();
    expect(lifecycle.state.streamingSessionId).toBeNull();
  });

  it('rapid start-stop-start maintains correct state', async () => {
    await lifecycle.startStream('session-1');
    await lifecycle.stopStream();
    await lifecycle.startStream('session-2');

    expect(lifecycle.stopCalls).toEqual(['session-1']);
    expect(lifecycle.state.streamingSessionId).toBe('session-2');
    expect(lifecycle.state.channelActive).toBe(true);
  });

  it('three consecutive starts stop each previous stream', async () => {
    await lifecycle.startStream('session-1');
    await lifecycle.startStream('session-2');
    await lifecycle.startStream('session-3');

    expect(lifecycle.stopCalls).toEqual(['session-1', 'session-2']);
    expect(lifecycle.startCalls).toEqual(['session-1', 'session-2', 'session-3']);
    expect(lifecycle.state.streamingSessionId).toBe('session-3');
  });

  it('channel is deactivated before stop is called', async () => {
    await lifecycle.startStream('session-1');

    // Verify the channel was active
    expect(lifecycle.state.channelActive).toBe(true);

    // Track channel state at the moment stop is called
    let channelWasActiveWhenStopping = true;
    lifecycle.stopAdbStream.mockImplementation(async () => {
      channelWasActiveWhenStopping = lifecycle.state.channelActive;
    });

    await lifecycle.startStream('session-2');

    // Channel must have been deactivated BEFORE stopAdbStream was called
    expect(channelWasActiveWhenStopping).toBe(false);
  });
});
