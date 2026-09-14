/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSplitView } from './splitView';
import type { SplitView } from './splitView';
import { ViewerSplit } from './ViewerSplit';

afterEach(cleanup);

const originalWidth = window.innerWidth;

/** jsdom has no matchMedia, so `createTier` reads innerWidth — set it before
 *  render (same pattern as `AppShell.test.tsx`). Defaults every test to a wide
 *  viewport: most of this suite is about the split's own mechanics, not tier
 *  gating (which has its own describe block below). */
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}
beforeEach(() => setViewportWidth(2600));
afterEach(() => setViewportWidth(originalWidth));

/** jsdom has no PointerEvent; a MouseEvent dispatched under the pointer type
 *  name is enough (same trick `Splitter.test.tsx` uses). */
function pointer(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { clientX, bubbles: true, button: 0 });
}

function mount(split: SplitView) {
  return render(() => (
    <ViewerSplit
      split={split}
      secondaryOptions={() => [
        { sessionId: 's1', label: 'one.log' },
        { sessionId: 's2', label: 'two.log' },
      ]}
      primary={() => <div data-testid="primary-content">primary</div>}
      secondary={(sessionId) => <div data-testid="secondary-content">{sessionId}</div>}
    />
  ));
}

describe('ViewerSplit', () => {
  it('renders only the primary pane when inactive', () => {
    const split = createSplitView();
    mount(split);

    expect(screen.getByTestId('primary-content')).toBeTruthy();
    expect(screen.queryByTestId('secondary-content')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('renders the divider and a placeholder once active with no session chosen', () => {
    const split = createSplitView();
    split.split();
    mount(split);

    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByText(/Pick a session above/)).toBeTruthy();
    expect(screen.queryByTestId('secondary-content')).toBeNull();
  });

  it('renders the chosen session in the secondary pane', () => {
    const split = createSplitView();
    split.split('s1');
    mount(split);

    expect(screen.getByTestId('secondary-content').textContent).toBe('s1');
  });

  it('the picker lists the given options and changing it updates the secondary session', () => {
    const split = createSplitView();
    split.split('s1');
    mount(split);

    const picker = screen.getByLabelText('Secondary pane session') as HTMLSelectElement;
    const optionValues = [...picker.options].map((o) => o.value).filter(Boolean);
    expect(optionValues).toEqual(['s1', 's2']);

    fireEvent.change(picker, { target: { value: 's2' } });
    expect(split.secondarySessionId()).toBe('s2');
  });

  it('the close button unsplits', () => {
    const split = createSplitView();
    split.split('s1');
    mount(split);

    fireEvent.click(screen.getByLabelText('Close split'));
    expect(split.active()).toBe(false);
    expect(split.secondarySessionId()).toBeNull();
  });

  it('marks the pane matching activePane() as active', () => {
    const split = createSplitView();
    split.split('s1');
    split.setActivePane('secondary');
    const { container } = mount(split);

    expect(container.querySelector('[data-pane="main"]')?.getAttribute('data-active')).toBe('false');
    expect(container.querySelector('[data-pane="secondary"]')?.getAttribute('data-active')).toBe('true');
  });

  it('dragging the divider updates the ratio via setRatio', () => {
    const split = createSplitView();
    split.split('s1');
    const setRatio = vi.spyOn(split, 'setRatio');
    const { container } = mount(split);
    Object.defineProperty(container.querySelector('[data-split]')!, 'clientWidth', {
      configurable: true,
      value: 1000,
    });

    const handle = screen.getByRole('separator');
    handle.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 600));

    expect(setRatio).toHaveBeenCalledWith(0.6);
    window.dispatchEvent(pointer('pointerup', 600));
  });

  it('double-clicking the divider resets the ratio to 0.5', () => {
    const split = createSplitView();
    split.split('s1');
    split.setRatio(0.25);
    mount(split);

    fireEvent.dblClick(screen.getByRole('separator'));
    expect(split.ratio()).toBe(0.5);
  });

  it('the arrow keys resize the divider', () => {
    const split = createSplitView();
    split.split('s1');
    mount(split);

    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(split.ratio()).toBeCloseTo(0.48);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(split.ratio()).toBeCloseTo(0.52);
  });
});

describe('ViewerSplit — tier gating (S1: split is wide/ultra-wide only)', () => {
  it('renders only the primary pane on compact and standard, even while active', () => {
    setViewportWidth(1024); // compact
    const split = createSplitView();
    split.split('s1');
    mount(split);

    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByTestId('secondary-content')).toBeNull();
    expect(screen.getByTestId('primary-content')).toBeTruthy();
    // The state itself is untouched — only how it renders right now.
    expect(split.active()).toBe(true);

    cleanup();
    setViewportWidth(1800); // standard
    mount(split);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('renders the split again once the viewport widens back to wide/ultra-wide', () => {
    setViewportWidth(1024);
    const split = createSplitView();
    split.split('s1');
    const { unmount } = mount(split);
    expect(screen.queryByRole('separator')).toBeNull();
    unmount();

    setViewportWidth(2600);
    mount(split);
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByTestId('secondary-content')).toBeTruthy();
  });
});
