import { describe, expect, it } from 'vitest';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '../workspace/layoutBlob';
import { SECONDARY_PANE_ID, createSplitView } from './splitView';

describe('createSplitView', () => {
  it('starts inactive with no secondary session and the default ratio', () => {
    const view = createSplitView();
    expect(view.active()).toBe(false);
    expect(view.secondarySessionId()).toBeNull();
    expect(view.ratio()).toBe(0.5);
    expect(view.activePane()).toBe('main');
  });

  it('split() activates, moves focus to the secondary pane, and leaves the session alone by default', () => {
    const view = createSplitView();
    view.setSecondarySession('s1');
    view.split();
    expect(view.active()).toBe(true);
    expect(view.secondarySessionId()).toBe('s1');
    expect(view.activePane()).toBe('secondary');
  });

  it('split(sessionId) seeds the secondary session', () => {
    const view = createSplitView();
    view.split('s2');
    expect(view.active()).toBe(true);
    expect(view.secondarySessionId()).toBe('s2');
  });

  it('unsplit() clears the secondary session and returns focus to main', () => {
    const view = createSplitView();
    view.split('s1');
    view.unsplit();
    expect(view.active()).toBe(false);
    expect(view.secondarySessionId()).toBeNull();
    expect(view.activePane()).toBe('main');
  });

  it('setRatio clamps to [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]', () => {
    const view = createSplitView();
    view.setRatio(0.01);
    expect(view.ratio()).toBe(MIN_SPLIT_RATIO);
    view.setRatio(0.99);
    expect(view.ratio()).toBe(MAX_SPLIT_RATIO);
    view.setRatio(0.6);
    expect(view.ratio()).toBe(0.6);
  });

  it('setActivePane tracks focus independent of split state', () => {
    const view = createSplitView();
    view.setActivePane('secondary');
    expect(view.activePane()).toBe('secondary');
    view.setActivePane('main');
    expect(view.activePane()).toBe('main');
  });

  it('handleSessionClosed clears the secondary session only when it matches', () => {
    const view = createSplitView();
    view.split('s1');
    view.handleSessionClosed('other');
    expect(view.secondarySessionId()).toBe('s1');
    view.handleSessionClosed('s1');
    expect(view.secondarySessionId()).toBeNull();
    // Split stays active — the picker's placeholder takes over, per task-scope.
    expect(view.active()).toBe(true);
  });

  it('toLayout()/applyLayout() round-trip', () => {
    const view = createSplitView();
    view.split('s1');
    view.setRatio(0.3);
    view.setActivePane('secondary');
    const layout = view.toLayout();
    expect(layout).toEqual({ active: true, secondarySessionId: 's1', ratio: 0.3 });

    const restored = createSplitView();
    restored.applyLayout(layout);
    expect(restored.active()).toBe(true);
    expect(restored.secondarySessionId()).toBe('s1');
    expect(restored.ratio()).toBe(0.3);
    // A restored split has not been clicked into yet.
    expect(restored.activePane()).toBe('main');
  });

  it('applyLayout clamps a corrupt ratio', () => {
    const view = createSplitView();
    view.applyLayout({ active: true, secondarySessionId: 's1', ratio: 5 });
    expect(view.ratio()).toBe(MAX_SPLIT_RATIO);
  });

  // A workspace saved with a split can be restored long after the session it
  // named was closed — nothing re-opens sessions to satisfy a layout. This
  // store deliberately does NOT validate the id (it has no session-store
  // dependency, by design); it restores verbatim and leaves existence to the
  // owner. `App.tsx` guards the render with
  // `<Show when={store.byId(sessionId)} fallback={…}>`, so a stale id shows
  // "That session is no longer open." instead of mounting a viewer over
  // nothing. Pinning the no-validation contract here keeps a later "helpful"
  // change from silently dropping the id and taking that fallback with it.
  it('applyLayout restores a secondary session id that is no longer open', () => {
    const view = createSplitView();
    view.applyLayout({ active: true, secondarySessionId: 'closed-session', ratio: 0.5 });
    expect(view.active()).toBe(true);
    expect(view.secondarySessionId()).toBe('closed-session');

    // The owner's session-close path is what clears it, and it still works on
    // an id that arrived from a restore rather than from `split()`.
    view.handleSessionClosed('closed-session');
    expect(view.secondarySessionId()).toBeNull();
    expect(view.active()).toBe(true);
  });

  it('exposes a stable secondary pane id constant', () => {
    expect(SECONDARY_PANE_ID).toBe('secondary');
  });
});
