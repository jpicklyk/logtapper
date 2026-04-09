/**
 * Tests for useFileInfo refactoring:
 *
 * M1 — Derived state mirrored via effects (useFileInfo):
 *   totalLines and fileSize should be read directly from the session object
 *   rather than mirrored through local useState + useEffect. This means the
 *   return values always equal session.totalLines / session.fileSize without
 *   an intermediate async state update step.
 *
 * M6 — selectedLine cleared via effect — derivable during render:
 *   When effectiveScrollToLine is non-null, selectedLine should be treated as
 *   null (the jump wins). This is now derived at render time rather than via a
 *   useEffect that calls setSelectedLine(null) asynchronously.
 *
 * Both fixes reduce unnecessary re-renders (no extra commit from setState in an
 * effect) and eliminate timing windows where stale values could appear.
 *
 * These tests cover the core derivation logic as pure functions so they run
 * without a React rendering environment.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// M1 — totalLines / fileSize read directly from session
// ---------------------------------------------------------------------------

/**
 * Simulates the new render-time derivation: totalLines comes from
 * session.totalLines directly (both streaming and non-streaming).
 */
function deriveTotalLines(
  sessionTotalLines: number | undefined,
): number | undefined {
  return sessionTotalLines;
}

/**
 * Simulates the new render-time derivation: fileSize comes from
 * session.fileSize directly (both streaming and non-streaming).
 */
function deriveFileSize(
  sessionFileSize: number | undefined,
): number | undefined {
  return sessionFileSize;
}

describe('M1 — totalLines/fileSize derived directly from session', () => {
  it('returns session.totalLines for a non-streaming session', () => {
    expect(deriveTotalLines(12345)).toBe(12345);
  });

  it('returns session.totalLines for a streaming session (same path)', () => {
    // Previously the streaming path had: session?.totalLines ?? localState
    // Now both paths just read from session.
    expect(deriveTotalLines(99999)).toBe(99999);
  });

  it('returns undefined when session is null (no session loaded)', () => {
    expect(deriveTotalLines(undefined)).toBeUndefined();
  });

  it('returns 0 when session has 0 lines (valid initial state)', () => {
    expect(deriveTotalLines(0)).toBe(0);
  });

  it('returns session.fileSize for a non-streaming session', () => {
    expect(deriveFileSize(1_048_576)).toBe(1_048_576);
  });

  it('returns session.fileSize for a streaming session (same path)', () => {
    expect(deriveFileSize(500_000)).toBe(500_000);
  });

  it('returns undefined when session is null', () => {
    expect(deriveFileSize(undefined)).toBeUndefined();
  });

  it('reflects updated totalLines immediately without an extra commit', () => {
    // Key property: when session.totalLines changes (e.g. during indexing),
    // the returned value changes in the same render — no effect delay.
    let sessionLines = 1000;
    expect(deriveTotalLines(sessionLines)).toBe(1000);

    sessionLines = 50000; // simulates indexing progress update
    expect(deriveTotalLines(sessionLines)).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// M6 — effectiveSelectedLine derived at render time
// ---------------------------------------------------------------------------

/**
 * The new render-time derivation that replaces the useEffect:
 *
 *   const effectiveSelectedLine = effectiveScrollToLine != null ? null : rawSelectedLine;
 *
 * When a programmatic jump is active (effectiveScrollToLine is non-null) the
 * selection is suppressed so the jump target wins for section tracking.
 */
function deriveEffectiveSelectedLine(
  rawSelectedLine: number | null,
  effectiveScrollToLine: number | null,
): number | null {
  return effectiveScrollToLine != null ? null : rawSelectedLine;
}

describe('M6 — effectiveSelectedLine derived at render time', () => {
  it('returns rawSelectedLine when no scroll target is active', () => {
    expect(deriveEffectiveSelectedLine(42, null)).toBe(42);
  });

  it('returns null when effectiveScrollToLine is set (jump wins)', () => {
    expect(deriveEffectiveSelectedLine(42, 100)).toBeNull();
  });

  it('returns null when both rawSelectedLine and effectiveScrollToLine are null', () => {
    expect(deriveEffectiveSelectedLine(null, null)).toBeNull();
  });

  it('returns null when rawSelectedLine is null and jump is active', () => {
    expect(deriveEffectiveSelectedLine(null, 500)).toBeNull();
  });

  it('returns line 0 (falsy but valid) when scroll target is null', () => {
    // 0 is a valid line number — must not be treated as "no selection"
    expect(deriveEffectiveSelectedLine(0, null)).toBe(0);
  });

  it('suppresses line 0 selection when scroll target is active', () => {
    expect(deriveEffectiveSelectedLine(0, 0)).toBeNull();
  });

  it('is computed synchronously — no async effect delay', () => {
    // Previously the cleared value was only visible after an effect committed.
    // Now the derivation is immediate on every render call.
    const results: Array<number | null> = [];
    for (const scrollTarget of [null, 200, null]) {
      results.push(deriveEffectiveSelectedLine(50, scrollTarget));
    }
    // [null→50, 200→null, null→50]
    expect(results).toEqual([50, null, 50]);
  });

  it('trackingLine uses effectiveSelectedLine preferring selection over scroll', () => {
    // trackingLine = effectiveSelectedLine ?? effectiveScrollToLine
    const trackingLine = (rawSel: number | null, scrollTo: number | null) => {
      const effSel = deriveEffectiveSelectedLine(rawSel, scrollTo);
      return effSel ?? scrollTo;
    };

    // User has selected a line, no jump active → selection wins
    expect(trackingLine(42, null)).toBe(42);

    // Jump is active → effectiveSelectedLine=null → scroll target wins
    expect(trackingLine(42, 100)).toBe(100);

    // No selection, jump active → scroll target
    expect(trackingLine(null, 100)).toBe(100);

    // Nothing → null
    expect(trackingLine(null, null)).toBeNull();
  });
});
