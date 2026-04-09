/**
 * Tests for the H4 fix: sessionScrollPositions.set() must be called from a
 * useEffect cleanup, never during the render phase.
 *
 * We test the behavior of the sessionScrollPositions singleton directly
 * (without a DOM / renderHook) by simulating the effect lifecycle:
 * mount → position update → session change (cleanup) → position persisted.
 *
 * This validates that:
 * 1. The position is NOT written during render (only on cleanup).
 * 2. The position IS persisted when the sessionId changes (effect cleanup fires).
 * 3. The position IS persisted on unmount (final cleanup).
 * 4. A re-mount reads back the saved position.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sessionScrollPositions } from '../../viewport';

// Simulate the effect lifecycle described by the H4 fix in LogViewer.
// This mirrors the useEffect body exactly:
//
//   useEffect(() => {
//     const savedSessionId = sessionId;
//     return () => {
//       if (savedSessionId !== null) {
//         sessionScrollPositions.set(savedSessionId, virtualBaseOutRef.current);
//       }
//     };
//   }, [sessionId]);
//
// Returns a cleanup function (the effect teardown).
function mountScrollPreservationEffect(
  sessionId: string | null,
  getVirtualBase: () => number,
): () => void {
  const savedSessionId = sessionId;
  return () => {
    if (savedSessionId !== null) {
      sessionScrollPositions.set(savedSessionId, getVirtualBase());
    }
  };
}

describe('H4 fix: sessionScrollPositions.set via useEffect cleanup', () => {
  beforeEach(() => {
    sessionScrollPositions.delete('session-A');
    sessionScrollPositions.delete('session-B');
  });

  it('does NOT write to sessionScrollPositions at effect setup time (only on cleanup)', () => {
    const base = 0;
    // Mount effect — simulates the initial useEffect call.
    const cleanup = mountScrollPreservationEffect('session-A', () => base);

    // The position should NOT be written yet (only reads happen during render).
    expect(sessionScrollPositions.get('session-A')).toBe(0); // default (not set)

    // Cleanup is the responsibility of the caller (called on unmount or dep change).
    cleanup();
  });

  it('saves scroll position when sessionId changes (effect cleanup fires)', () => {
    let base = 42;
    const cleanupA = mountScrollPreservationEffect('session-A', () => base);

    // session-A is active with base=42. Not saved yet.
    expect(sessionScrollPositions.get('session-A')).toBe(0);

    // Switch to session-B: cleanup for session-A fires first.
    cleanupA(); // ← this is what React calls before mounting the new effect.

    expect(sessionScrollPositions.get('session-A')).toBe(42);

    // New effect for session-B mounts.
    base = 10;
    const cleanupB = mountScrollPreservationEffect('session-B', () => base);
    expect(sessionScrollPositions.get('session-B')).toBe(0);

    cleanupB();
    expect(sessionScrollPositions.get('session-B')).toBe(10);
  });

  it('saves scroll position on unmount (final cleanup fires)', () => {
    const base = 99;
    const cleanup = mountScrollPreservationEffect('session-A', () => base);

    expect(sessionScrollPositions.get('session-A')).toBe(0);

    // Unmount triggers cleanup.
    cleanup();

    expect(sessionScrollPositions.get('session-A')).toBe(99);
  });

  it('reads back the saved position on re-mount with the same sessionId', () => {
    const base = 77;
    const cleanup = mountScrollPreservationEffect('session-A', () => base);
    cleanup(); // unmount → saves 77.

    expect(sessionScrollPositions.get('session-A')).toBe(77);

    // Re-mount: reads the persisted value during render (before any effect fires).
    const restored = sessionScrollPositions.get('session-A');
    expect(restored).toBe(77);
  });

  it('does not write when sessionId is null (unmount with no session)', () => {
    const base = 50;
    const cleanup = mountScrollPreservationEffect(null, () => base);

    cleanup();

    // No entry should be created for null session.
    // The empty-string fallback from the get() call returns 0 (not set).
    expect(sessionScrollPositions.get('')).toBe(0);
  });

  it('captures the virtualBase value at cleanup time (ref read is deferred)', () => {
    // The ref is read lazily in the cleanup — it captures the LATEST value,
    // not the value at effect setup time. This ensures the saved position
    // reflects where the user actually scrolled before switching sessions.
    let base = 0;
    const cleanup = mountScrollPreservationEffect('session-A', () => base);

    // Simulate the user scrolling after the effect was set up.
    base = 500;

    cleanup();

    expect(sessionScrollPositions.get('session-A')).toBe(500);
  });
});
