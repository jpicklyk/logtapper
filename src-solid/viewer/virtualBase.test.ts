import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createVirtualBase, MAX_BROWSER_SCROLL_PX, DEFAULT_ROW_HEIGHT } from './virtualBase';
import type { VirtualBase, VirtualBaseOptions } from './virtualBase';
import { sessionScrollPositions } from '@viewport/sessionScrollPositions';

const SESSIONS = ['vb-session-A', 'vb-session-B'];

/**
 * Build a VirtualBase inside its own root and return once Solid has flushed the
 * initial effect run — `createRoot` defers queued effects until its callback
 * returns, so every mutation in a test must happen after this helper.
 */
function mount(options: VirtualBaseOptions): VirtualBase & { dispose: () => void } {
  return createRoot((dispose) => ({ ...createVirtualBase(options), dispose }));
}

afterEach(() => {
  SESSIONS.forEach((s) => sessionScrollPositions.delete(s));
});

describe('createVirtualBase', () => {
  // ── Max virtual lines from the runtime row height ────────────────────────

  describe('maxVirtualLines', () => {
    it('derives from the default row height when none is given', () => {
      const vb = mount({ sourceId: () => 's' });
      expect(vb.maxVirtualLines()).toBe(Math.floor(MAX_BROWSER_SCROLL_PX / DEFAULT_ROW_HEIGHT));
      expect(vb.maxVirtualLines()).toBe(1_525_201);
      vb.dispose();
    });

    it('derives from a constant row height', () => {
      const vb = mount({ sourceId: () => 's', rowHeight: 16 });
      expect(vb.maxVirtualLines()).toBe(Math.floor(MAX_BROWSER_SCROLL_PX / 16));
      expect(vb.maxVirtualLines()).toBe(2_097_151);
      vb.dispose();
    });

    it('tracks a reactive row height', () => {
      const [rowHeight, setRowHeight] = createSignal(22);
      const vb = mount({ sourceId: () => 's', rowHeight });

      expect(vb.maxVirtualLines()).toBe(Math.floor(MAX_BROWSER_SCROLL_PX / 22));
      setRowHeight(33);
      expect(vb.maxVirtualLines()).toBe(Math.floor(MAX_BROWSER_SCROLL_PX / 33));
      vb.dispose();
    });

    it('never divides by zero', () => {
      const vb = mount({ sourceId: () => 's', rowHeight: 0 });
      expect(vb.maxVirtualLines()).toBe(MAX_BROWSER_SCROLL_PX);
      vb.dispose();
    });
  });

  // ── Signal + non-reactive mirror ─────────────────────────────────────────

  it('setVirtualBase writes both the signal and the current mirror', () => {
    const vb = mount({ sourceId: () => 's' });
    expect(vb.virtualBase()).toBe(0);
    expect(vb.current.value).toBe(0);

    vb.setVirtualBase(5000);

    expect(vb.virtualBase()).toBe(5000);
    expect(vb.current.value).toBe(5000);
    vb.dispose();
  });

  // ── Reset on source change ───────────────────────────────────────────────

  describe('source change', () => {
    it('resets the window to 0 when the sourceId changes', () => {
      const [sourceId, setSourceId] = createSignal('a:full');
      const vb = mount({ sourceId });

      vb.setVirtualBase(12_000);
      expect(vb.virtualBase()).toBe(12_000);

      setSourceId('b:full');

      expect(vb.virtualBase()).toBe(0);
      expect(vb.current.value).toBe(0);
      vb.dispose();
    });

    it('clears any pending scroll target on source change', () => {
      const [sourceId, setSourceId] = createSignal('a:full');
      const vb = mount({ sourceId });

      vb.pendingScrollTarget.value = 900_000;
      setSourceId('b:full');

      expect(vb.pendingScrollTarget.value).toBeNull();
      vb.dispose();
    });

    it('restores an explicit initialVirtualBase', () => {
      const vb = mount({ sourceId: () => 'a:full', initialVirtualBase: () => 7_500 });
      expect(vb.virtualBase()).toBe(7_500);
      expect(vb.current.value).toBe(7_500);
      vb.dispose();
    });

    // M7: `sourceId` is `${sessionId}:${'filtered' | 'full'}`. Only the session
    // half may restore a saved position — the saved value is a *file-line*
    // offset, which means nothing in a filtered index space.
    it('resets to 0 — not the saved file-line offset — when a filter is applied', () => {
      sessionScrollPositions.set(SESSIONS[0], 2_200_000);
      const [sourceId, setSourceId] = createSignal(`${SESSIONS[0]}:full`);
      const vb = mount({ sourceId, sessionId: () => SESSIONS[0] });
      expect(vb.virtualBase()).toBe(2_200_000);

      // A 120-match filter arrives: restoring 2.2 M here clamps renderCount to
      // 0 and leaves a permanently blank viewer.
      setSourceId(`${SESSIONS[0]}:filtered`);

      expect(vb.virtualBase()).toBe(0);
      expect(vb.current.value).toBe(0);
      vb.dispose();
    });

    it('resets to 0 again when the filter is cleared', () => {
      const [sourceId, setSourceId] = createSignal(`${SESSIONS[0]}:filtered`);
      const vb = mount({ sourceId, sessionId: () => SESSIONS[0] });
      vb.setVirtualBase(60);

      setSourceId(`${SESSIONS[0]}:full`);

      expect(vb.virtualBase()).toBe(0);
      vb.dispose();
    });

    it('still restores the saved position for a genuine session switch', () => {
      sessionScrollPositions.set(SESSIONS[1], 4_321);
      const [sourceId, setSourceId] = createSignal(`${SESSIONS[0]}:full`);
      const [sessionId, setSessionId] = createSignal<string | undefined>(SESSIONS[0]);
      const vb = mount({ sourceId, sessionId });

      setSessionId(SESSIONS[1]);
      setSourceId(`${SESSIONS[1]}:full`);

      expect(vb.virtualBase()).toBe(4_321);
      vb.dispose();
    });
  });

  // ── Tail mode ────────────────────────────────────────────────────────────

  describe('tail mode', () => {
    it('pins the window to 0 when tail mode is entered', () => {
      const [tailMode, setTailMode] = createSignal(false);
      const vb = mount({ sourceId: () => 's', tailMode });

      vb.setVirtualBase(3_000);
      setTailMode(true);

      expect(vb.virtualBase()).toBe(0);
      expect(vb.current.value).toBe(0);
      vb.dispose();
    });

    it('leaves the window alone when tail mode is left', () => {
      const [tailMode, setTailMode] = createSignal(true);
      const vb = mount({ sourceId: () => 's', tailMode });

      vb.setVirtualBase(400);
      setTailMode(false);

      expect(vb.virtualBase()).toBe(400);
      vb.dispose();
    });
  });

  // ── sessionScrollPositions persistence ───────────────────────────────────

  describe('sessionScrollPositions persistence', () => {
    it('does NOT write at setup time — only on teardown', () => {
      const vb = mount({ sourceId: () => 'a:full', sessionId: () => SESSIONS[0] });
      vb.setVirtualBase(42);

      expect(sessionScrollPositions.get(SESSIONS[0])).toBe(0);

      vb.dispose();

      expect(sessionScrollPositions.get(SESSIONS[0])).toBe(42);
    });

    it('saves the outgoing session when the sessionId changes', () => {
      const [sessionId, setSessionId] = createSignal<string | undefined>(SESSIONS[0]);
      const vb = mount({ sourceId: () => `${sessionId()}:full`, sessionId });

      vb.setVirtualBase(77);
      setSessionId(SESSIONS[1]);

      expect(sessionScrollPositions.get(SESSIONS[0])).toBe(77);
      // The incoming session has no saved position — the window resets.
      expect(vb.virtualBase()).toBe(0);
      vb.dispose();
    });

    it('restores a saved position on a fresh mount', () => {
      sessionScrollPositions.set(SESSIONS[0], 999);
      const vb = mount({ sourceId: () => 'a:full', sessionId: () => SESSIONS[0] });
      expect(vb.virtualBase()).toBe(999);
      expect(vb.current.value).toBe(999);
      vb.dispose();
    });

    it('starts at 0 for a session with no saved position', () => {
      const vb = mount({ sourceId: () => 'a:full', sessionId: () => SESSIONS[1] });
      expect(vb.virtualBase()).toBe(0);
      vb.dispose();
    });
  });
});
