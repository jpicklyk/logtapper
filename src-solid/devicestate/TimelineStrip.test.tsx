/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { ProcessorSummary, StateTransition } from '@bridge/types';
import { TimelineStrip } from './TimelineStrip';
import type { DeviceStateController, DeviceStateStore, TrackerTimelineTrack } from './deviceStateStore';

afterEach(cleanup);

function tracker(id: string): ProcessorSummary {
  return { id, name: id } as unknown as ProcessorSummary;
}

function transition(lineNum: number): StateTransition {
  return { lineNum, timestamp: 0, transitionName: 't', changes: {} };
}

function track(overrides: Partial<TrackerTimelineTrack> = {}): TrackerTimelineTrack {
  return { trackerId: 't1', trackerName: 'USB state', transitions: [transition(10), transition(90)], ...overrides };
}

function fakeStore(overrides: Partial<DeviceStateStore> = {}): DeviceStateStore {
  return {
    trackers: vi.fn(() => [tracker('t1')]),
    timeline: vi.fn(() => track()),
    ...overrides,
  } as unknown as DeviceStateStore;
}

function fakeController(overrides: Partial<DeviceStateController> = {}): DeviceStateController {
  return {
    cursor: () => null,
    scrollToLine: vi.fn(),
    ...overrides,
  };
}

/** jsdom has no PointerEvent; a MouseEvent dispatched under the pointer type name is enough. */
function pointer(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { clientX, bubbles: true, button: 0 });
}

describe('TimelineStrip', () => {
  it('is collapsed until the toggle is clicked', () => {
    render(() => (
      <TimelineStrip store={fakeStore()} controller={fakeController()} sessionId="s1" totalLines={100} />
    ));
    expect(screen.queryByRole('group', { name: /timeline/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /timeline/i }));
    expect(screen.getByRole('group', { name: /timeline/i })).toBeTruthy();
  });

  it('shows one track per active, timeline-enabled tracker with a non-empty history', () => {
    const store = fakeStore({
      trackers: vi.fn(() => [tracker('t1'), tracker('t2')]),
      timeline: vi.fn((_sid, id) =>
        id === 't1' ? track() : { trackerId: 't2', trackerName: 'empty', transitions: [] },
      ),
    });
    render(() => <TimelineStrip store={store} controller={fakeController()} sessionId="s1" totalLines={100} />);
    fireEvent.click(screen.getByRole('button', { name: /timeline/i }));
    expect(screen.getByText('USB state')).toBeTruthy();
    expect(screen.queryByText('empty')).toBeNull();
  });

  it('shows an empty state when no tracker has recorded transitions', () => {
    const store = fakeStore({ timeline: vi.fn(() => ({ ...track(), transitions: [] })) });
    render(() => <TimelineStrip store={store} controller={fakeController()} sessionId="s1" totalLines={100} />);
    fireEvent.click(screen.getByRole('button', { name: /timeline/i }));
    expect(screen.getByText(/no transitions recorded/i)).toBeTruthy();
  });

  it('reuses timelineUtils.linePct for tick and cursor placement', () => {
    const controller = fakeController({ cursor: () => ({ sessionId: 's1', line: 50 }) });
    render(() => (
      <TimelineStrip store={fakeStore()} controller={controller} sessionId="s1" totalLines={101} />
    ));
    fireEvent.click(screen.getByRole('button', { name: /timeline/i }));

    const svg = screen.getByRole('slider', { name: /usb state timeline/i });
    const ticks = svg.querySelectorAll('line');
    // baseline + 2 transition ticks (10, 90) + 1 cursor line at 50, maxLine=100.
    expect(ticks).toHaveLength(4);
    const cursorLine = ticks[ticks.length - 1];
    expect(cursorLine.getAttribute('x1')).toBe('50');
  });

  it('scrubbing the strip jumps the viewer to the fractional line', () => {
    const controller = fakeController();
    render(() => (
      <TimelineStrip store={fakeStore()} controller={controller} sessionId="s1" totalLines={101} />
    ));
    fireEvent.click(screen.getByRole('button', { name: /timeline/i }));
    const svg = screen.getByRole('slider', { name: /usb state timeline/i });
    svg.getBoundingClientRect = () => ({ left: 0, right: 200, width: 200, top: 0, bottom: 0, height: 0 }) as DOMRect;

    svg.dispatchEvent(pointer('pointerdown', 100)); // 50% across → line 50 of maxLine=100
    expect(controller.scrollToLine).toHaveBeenCalledWith('s1', 50, { source: 'user' });

    window.dispatchEvent(pointer('pointermove', 0));
    expect(controller.scrollToLine).toHaveBeenLastCalledWith('s1', 0, { source: 'user' });

    window.dispatchEvent(pointer('pointerup', 0));
    // A further move after pointerup must not jump again.
    (controller.scrollToLine as ReturnType<typeof vi.fn>).mockClear();
    window.dispatchEvent(pointer('pointermove', 200));
    expect(controller.scrollToLine).not.toHaveBeenCalled();
  });

  it('collapses on Escape', () => {
    render(() => (
      <TimelineStrip store={fakeStore()} controller={fakeController()} sessionId="s1" totalLines={100} />
    ));
    fireEvent.click(screen.getByRole('button', { name: /timeline/i }));
    expect(screen.getByRole('group', { name: /timeline/i })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: /timeline/i })).toBeNull();
  });
});
