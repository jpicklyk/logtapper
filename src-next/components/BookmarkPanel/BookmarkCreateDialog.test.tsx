// @vitest-environment jsdom
/**
 * U3 — labelFetchedRef must be a per-request token, not a dead null-only guard.
 *
 * Before the fix, labelFetchedRef was only ever assigned `null`, so the
 * staleness check `if (labelFetchedRef.current !== null) return;` never
 * fired — a slow getLines() from a previously opened dialog could still
 * fill in the label for a newer dialog/request. The fix stamps a
 * `${sessionId}:${lineNumber}` token before the fetch starts and compares
 * it when the fetch resolves.
 *
 * These tests exercise the guard logic directly (extracted from
 * BookmarkCreateDialog's effect) rather than mounting the full dialog,
 * following the pattern in ProcessorPanel.test.tsx.
 */
import { describe, it, expect } from 'vitest';

interface Req {
  sessionId: string;
  lineNumber: number;
}

/** Mirrors the fixed effect body's label-fetch guard. */
function makeLabelFetcher() {
  const labelFetchedRef = { current: null as string | null };

  function startFetch(request: Req) {
    const token = `${request.sessionId}:${request.lineNumber}`;
    labelFetchedRef.current = token;
    return token;
  }

  function resolveFetch(token: string, generatedLabel: string, setLabel: (v: string) => void) {
    if (labelFetchedRef.current !== token) return; // request changed — discard
    setLabel(generatedLabel);
  }

  return { labelFetchedRef, startFetch, resolveFetch };
}

describe('[U3] BookmarkCreateDialog label-fetch staleness guard', () => {
  it('discards a stale fetch resolution when a newer request has started', () => {
    const { startFetch, resolveFetch } = makeLabelFetcher();
    let label = '';
    const setLabel = (v: string) => { label = v; };

    // Dialog opens for line 10 in session A — fetch starts (in flight).
    const tokenA = startFetch({ sessionId: 'session-a', lineNumber: 10 });

    // Before A's fetch resolves, the dialog is reopened for line 42 in
    // session A (or a different session) — this stamps a new token.
    startFetch({ sessionId: 'session-a', lineNumber: 42 });

    // A's slow fetch now resolves — must be ignored, since it belongs to a
    // superseded request.
    resolveFetch(tokenA, 'STALE LABEL', setLabel);

    expect(label).toBe('');
  });

  it('applies the fetch resolution when it belongs to the current request', () => {
    const { startFetch, resolveFetch } = makeLabelFetcher();
    let label = '';
    const setLabel = (v: string) => { label = v; };

    const token = startFetch({ sessionId: 'session-a', lineNumber: 10 });
    resolveFetch(token, 'MainActivity: onCreate', setLabel);

    expect(label).toBe('MainActivity: onCreate');
  });

  it('generates distinct tokens for different sessions at the same line number', () => {
    const { startFetch } = makeLabelFetcher();
    const tokenA = startFetch({ sessionId: 'session-a', lineNumber: 5 });
    const tokenB = startFetch({ sessionId: 'session-b', lineNumber: 5 });

    expect(tokenA).not.toBe(tokenB);
  });
});
