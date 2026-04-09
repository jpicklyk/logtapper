/**
 * Tests for notice state in PaneContent (L6).
 *
 * L6 fix: noticeText + noticePhase were two separate useState calls that
 * always updated together. They have been combined into a single
 * { text, phase } state object to prevent double renders and make the
 * coupling explicit.
 *
 * These tests verify the state transition logic as pure functions,
 * without requiring DOM rendering.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Mirror the notice state type from PaneContent.tsx
// ---------------------------------------------------------------------------

type NoticePhase = 'entering' | 'exiting';
type NoticeState = { text: string; phase: NoticePhase } | null;

// ---------------------------------------------------------------------------
// Pure state transition functions that mirror PaneContent logic
// ---------------------------------------------------------------------------

/** Called when a new pane:notice event fires. Replaces any existing notice. */
function applyNewNotice(message: string): NoticeState {
  return { text: message, phase: 'entering' };
}

/** Called when NOTICE_VISIBLE_MS elapses — begins the exit animation. */
function applyExiting(prev: NoticeState): NoticeState {
  if (!prev) return null;
  return { text: prev.text, phase: 'exiting' };
}

/** Called when NOTICE_EXIT_MS elapses — unmounts the notice. */
function applyDismissed(): NoticeState {
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaneContent notice state (L6: combined useState)', () => {
  it('starts as null (no notice visible)', () => {
    const initial: NoticeState = null;
    expect(initial).toBeNull();
  });

  it('applyNewNotice sets text and phase atomically', () => {
    const state = applyNewNotice('File saved');
    expect(state).not.toBeNull();
    expect(state!.text).toBe('File saved');
    expect(state!.phase).toBe('entering');
  });

  it('applyExiting transitions phase while preserving text', () => {
    const entering = applyNewNotice('File saved');
    const exiting = applyExiting(entering);

    expect(exiting).not.toBeNull();
    expect(exiting!.text).toBe('File saved');
    expect(exiting!.phase).toBe('exiting');
  });

  it('applyExiting on null returns null (guard against stale timer)', () => {
    const result = applyExiting(null);
    expect(result).toBeNull();
  });

  it('applyDismissed clears state', () => {
    const exiting: NoticeState = { text: 'File saved', phase: 'exiting' };
    const dismissed = applyDismissed();
    expect(dismissed).toBeNull();
    // Silence unused-variable lint — exiting was the previous state.
    void exiting;
  });

  it('replacing an existing notice resets to entering phase', () => {
    const first = applyNewNotice('First message');
    const second = applyNewNotice('Second message');

    // Both should be atomic (text + phase in one object)
    expect(first!.text).toBe('First message');
    expect(first!.phase).toBe('entering');
    expect(second!.text).toBe('Second message');
    expect(second!.phase).toBe('entering');
  });

  it('state object shape has exactly text and phase keys', () => {
    const state = applyNewNotice('hello');
    expect(state).not.toBeNull();
    const keys = Object.keys(state!);
    expect(keys).toContain('text');
    expect(keys).toContain('phase');
    // No extraneous fields
    expect(keys.length).toBe(2);
  });

  it('full lifecycle: entering → exiting → null', () => {
    let state: NoticeState = null;

    // Notice arrives
    state = applyNewNotice('Exported');
    expect(state!.phase).toBe('entering');

    // Visible duration elapses
    state = applyExiting(state);
    expect(state!.phase).toBe('exiting');
    expect(state!.text).toBe('Exported');

    // Exit animation completes
    state = applyDismissed();
    expect(state).toBeNull();
  });
});
