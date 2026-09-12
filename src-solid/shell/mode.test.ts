import { describe, expect, it } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createMode, modeForKind } from './mode';
import type { SessionKind } from './mode';

describe('modeForKind', () => {
  it('treats only an ADB stream as live', () => {
    expect(modeForKind('live')).toBe('live');
    expect(modeForKind('file')).toBe('postmortem');
    expect(modeForKind(null)).toBe('postmortem');
    expect(modeForKind(undefined)).toBe('postmortem');
  });
});

describe('createMode', () => {
  it('tracks the focused session kind and mirrors it onto data-mode', () => {
    const root = document.createElement('html');

    const [kind, setKind] = createSignal<SessionKind>(null);

    // Effects flush when the root's update cycle ends, so assert after it.
    let mode!: ReturnType<typeof createMode>;
    let dispose!: () => void;
    createRoot((disposer) => {
      dispose = disposer;
      mode = createMode({ sessionKind: kind, root });
    });

    expect(mode()).toBe('postmortem');
    expect(root.getAttribute('data-mode')).toBe('postmortem');

    setKind('live');
    expect(mode()).toBe('live');
    expect(root.getAttribute('data-mode')).toBe('live');

    setKind('file');
    expect(mode()).toBe('postmortem');
    expect(root.getAttribute('data-mode')).toBe('postmortem');

    dispose();
  });
});
