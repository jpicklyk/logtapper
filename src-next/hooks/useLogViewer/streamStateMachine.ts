/**
 * Pure stream state machine extracted from useStreamSession.
 *
 * Encodes the ordering invariant: channelActive must be set to false
 * BEFORE stopAdbStream is called, preventing late channel messages
 * from being processed after teardown begins.
 */

export interface StreamRefs {
  streamingSessionIdRef: { current: string | null };
  isStreamingRef: { current: boolean };
  channelActiveRef: { current: boolean };
}

export interface StreamDeps {
  stopAdbStream: (sessionId: string) => Promise<void>;
}

/**
 * Tear down an active stream: deactivate channel, call stop, clear state.
 * The channel is deactivated before the stop call to prevent race conditions
 * with late-arriving channel messages.
 */
export async function teardownStream(
  refs: StreamRefs,
  deps: StreamDeps,
  sessionId: string,
): Promise<void> {
  refs.channelActiveRef.current = false;
  try {
    await deps.stopAdbStream(sessionId);
  } catch (e) {
    console.warn('[teardownStream] stopAdbStream failed (best-effort):', e);
  }
  refs.isStreamingRef.current = false;
  refs.streamingSessionIdRef.current = null;
}

/**
 * Activate stream state after a successful backend start.
 */
export function activateStream(
  refs: StreamRefs,
  sessionId: string,
): void {
  refs.channelActiveRef.current = true;
  refs.isStreamingRef.current = true;
  refs.streamingSessionIdRef.current = sessionId;
}
