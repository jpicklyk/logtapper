// @vitest-environment jsdom
/**
 * `useWatchList` — the `watch-update` merge.
 *
 * The backend emits `watch-update` from `services::watches` for BOTH callers, so
 * this listener is what makes an agent-created watch appear in the panel without
 * a manual refresh. Three things have to hold: the event is matched on
 * `sessionId` (never applied as a broadcast), the merge is an upsert keyed by
 * `watchId` (so a redelivery, or the UI seeing its own mutation come back, does
 * not duplicate a row), and a `cancelled` event updates the existing row in
 * place rather than appending a second one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { WatchInfo, WatchMatchEvent, WatchUpdateEvent } from '../bridge/types';

const listWatchesMock = vi.fn<(sessionId: string) => Promise<WatchInfo[]>>();

let emitWatchUpdate: ((e: WatchUpdateEvent) => void) | null = null;
let emitWatchMatch: ((e: WatchMatchEvent) => void) | null = null;
const unlistenUpdate = vi.fn();

vi.mock('../bridge/commands', () => ({
  listWatches: (sessionId: string) => listWatchesMock(sessionId),
}));

vi.mock('../bridge/events', () => ({
  onWatchMatch: (cb: (e: WatchMatchEvent) => void) => {
    emitWatchMatch = cb;
    return Promise.resolve(() => {});
  },
  onWatchUpdate: (cb: (e: WatchUpdateEvent) => void) => {
    emitWatchUpdate = cb;
    return Promise.resolve(unlistenUpdate);
  },
}));

import { useWatchList } from './useWatchList';

function watch(watchId: string, sessionId: string, over: Partial<WatchInfo> = {}): WatchInfo {
  return {
    watchId,
    sessionId,
    totalMatches: 0,
    active: true,
    criteria: {
      textSearch: null, regex: null, logLevels: null, tags: null,
      timeStart: null, timeEnd: null, pids: null, combine: 'and',
    },
    ...over,
  };
}

function update(action: 'created' | 'cancelled', w: WatchInfo): WatchUpdateEvent {
  return { action, watch: w, sessionId: w.sessionId };
}

describe('useWatchList — watch-update merge', () => {
  beforeEach(() => {
    listWatchesMock.mockReset();
    listWatchesMock.mockResolvedValue([]);
    emitWatchUpdate = null;
    emitWatchMatch = null;
    unlistenUpdate.mockReset();
  });

  it('appends a watch created for THIS session', async () => {
    const { result } = renderHook(() => useWatchList('s1'));
    await waitFor(() => expect(emitWatchUpdate).not.toBeNull());

    act(() => { emitWatchUpdate!(update('created', watch('w1', 's1'))); });

    expect(result.current.watches.map((w) => w.watchId)).toEqual(['w1']);
  });

  it('ignores a watch created for a DIFFERENT session', async () => {
    const { result } = renderHook(() => useWatchList('s1'));
    await waitFor(() => expect(emitWatchUpdate).not.toBeNull());

    act(() => { emitWatchUpdate!(update('created', watch('w9', 's2'))); });

    expect(result.current.watches).toEqual([]);
  });

  it('does not duplicate a watch already in the list (optimistic/redelivered)', async () => {
    listWatchesMock.mockResolvedValue([watch('w1', 's1', { totalMatches: 4 })]);
    const { result } = renderHook(() => useWatchList('s1'));
    await waitFor(() => expect(result.current.watches).toHaveLength(1));
    await waitFor(() => expect(emitWatchUpdate).not.toBeNull());

    act(() => { emitWatchUpdate!(update('created', watch('w1', 's1', { totalMatches: 4 }))); });

    expect(result.current.watches).toHaveLength(1);
    expect(result.current.watches[0].watchId).toBe('w1');
  });

  it('flips an existing row to inactive on cancel rather than appending', async () => {
    listWatchesMock.mockResolvedValue([watch('w1', 's1')]);
    const { result } = renderHook(() => useWatchList('s1'));
    await waitFor(() => expect(result.current.watches).toHaveLength(1));
    await waitFor(() => expect(emitWatchUpdate).not.toBeNull());

    act(() => {
      emitWatchUpdate!(update('cancelled', watch('w1', 's1', { active: false, totalMatches: 2 })));
    });

    expect(result.current.watches).toHaveLength(1);
    expect(result.current.watches[0].active).toBe(false);
    expect(result.current.watches[0].totalMatches).toBe(2);
  });

  it('a later watch-match still wins over the event count', async () => {
    const { result } = renderHook(() => useWatchList('s1'));
    await waitFor(() => expect(emitWatchUpdate).not.toBeNull());

    act(() => { emitWatchUpdate!(update('created', watch('w1', 's1'))); });
    act(() => {
      emitWatchMatch!({ watchId: 'w1', sessionId: 's1', newMatches: 3, totalMatches: 3 });
    });

    expect(result.current.watches[0].totalMatches).toBe(3);
  });

  it('clears the list and fetches nothing when the pane has no session', async () => {
    const { result } = renderHook(() => useWatchList(null));
    expect(result.current.watches).toEqual([]);
    expect(listWatchesMock).not.toHaveBeenCalled();
  });

  it('refetches when the pane switches session', async () => {
    listWatchesMock.mockImplementation((id) => Promise.resolve([watch(`${id}-w`, id)]));
    const { result, rerender } = renderHook(({ sid }) => useWatchList(sid), {
      initialProps: { sid: 's1' },
    });
    await waitFor(() => expect(result.current.watches[0]?.watchId).toBe('s1-w'));

    rerender({ sid: 's2' });
    await waitFor(() => expect(result.current.watches[0]?.watchId).toBe('s2-w'));
    expect(result.current.watches).toHaveLength(1);
  });
});
