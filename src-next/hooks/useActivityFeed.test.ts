// @vitest-environment jsdom
/**
 * `useActivityFeed` — the bounded shared UI + agent journal.
 *
 * The hook fetches once and then listens, so the two things worth pinning are
 * that the two sources reconcile by `id` (an append that races the initial
 * fetch must not double-count) and that the in-memory tail stays bounded — the
 * backend ring is 500 and a long session must not grow the UI copy past its own
 * cap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ActivityEntry } from '../bridge/types';

const getActivityMock = vi.fn<(limit?: number, sinceId?: number) => Promise<ActivityEntry[]>>();
let emitActivity: ((e: ActivityEntry) => void) | null = null;
const unlisten = vi.fn();

vi.mock('../bridge/commands', () => ({
  getActivity: (limit?: number, sinceId?: number) => getActivityMock(limit, sinceId),
}));

vi.mock('../bridge/events', () => ({
  onActivity: (cb: (e: ActivityEntry) => void) => {
    emitActivity = cb;
    return Promise.resolve(unlisten);
  },
}));

import { useActivityFeed } from './useActivityFeed';

function entry(id: number, over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    ts: 1_700_000_000_000 + id,
    caller: { kind: 'ui' },
    action: 'bookmark.create',
    sessionId: 's1',
    summary: `entry ${id}`,
    ...over,
  };
}

describe('useActivityFeed', () => {
  beforeEach(() => {
    getActivityMock.mockReset();
    getActivityMock.mockResolvedValue([]);
    emitActivity = null;
    unlisten.mockReset();
  });

  it('seeds from one getActivity call and appends live entries', async () => {
    getActivityMock.mockResolvedValue([entry(1), entry(2)]);
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    act(() => { emitActivity!(entry(3, { action: 'watch.create' })); });

    expect(result.current.entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(result.current.latest?.action).toBe('watch.create');
  });

  it('dedupes an append that also appears in the initial fetch', async () => {
    let resolveFetch: (v: ActivityEntry[]) => void = () => {};
    getActivityMock.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(emitActivity).not.toBeNull());

    // Live entry lands first, then the fetch resolves carrying the same id.
    act(() => { emitActivity!(entry(7)); });
    await act(async () => { resolveFetch([entry(6), entry(7)]); });

    expect(result.current.entries.map((e) => e.id)).toEqual([6, 7]);
  });

  it('keeps the newest entries and never exceeds the 200-entry bound', async () => {
    getActivityMock.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => entry(i + 1)),
    );
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(result.current.count).toBe(200));

    act(() => {
      for (let i = 201; i <= 210; i++) emitActivity!(entry(i));
    });

    expect(result.current.count).toBe(200);
    expect(result.current.entries[0].id).toBe(11);
    expect(result.current.latest?.id).toBe(210);
  });

  it('survives a failed read — the status bar must not break on it', async () => {
    getActivityMock.mockRejectedValue(new Error('bridge down'));
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(emitActivity).not.toBeNull());

    act(() => { emitActivity!(entry(1)); });

    expect(result.current.count).toBe(1);
    expect(result.current.latest?.id).toBe(1);
  });

  it('tags agent entries with the calling client', async () => {
    getActivityMock.mockResolvedValue([
      entry(1, { caller: { kind: 'agent', client: 'claude' }, action: 'session.open' }),
    ]);
    const { result } = renderHook(() => useActivityFeed());
    await waitFor(() => expect(result.current.count).toBe(1));

    expect(result.current.latest?.caller).toEqual({ kind: 'agent', client: 'claude' });
  });
});
