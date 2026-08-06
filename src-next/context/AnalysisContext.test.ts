// @vitest-environment jsdom
/**
 * Tests for AnalysisContext — the workspace-owned analysis store.
 *
 * Covers the initial load, each `analysis-update` action branch, the
 * unconditional `workspace:mutated` durability signal (see context/CLAUDE.md's
 * "Backend-originated mutations" section), and the StrictMode-safe async
 * listener pattern (src-next/CLAUDE.md #1) — no duplicate/leaked listeners
 * across the double-mount.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, render, act, waitFor } from '@testing-library/react';
import React, { createElement, type ReactNode } from 'react';
import type { AnalysisArtifact, AnalysisUpdateEvent } from '../bridge/types';

// ---------------------------------------------------------------------------
// Mocks — bridge commands, bridge events, event bus
// ---------------------------------------------------------------------------

const mockListAnalyses = vi.fn();
const mockGetAnalysis = vi.fn();

vi.mock('../bridge/commands', () => ({
  listAnalyses: (...args: unknown[]) => mockListAnalyses(...args),
  getAnalysis: (...args: unknown[]) => mockGetAnalysis(...args),
}));

/** Each call to onAnalysisUpdate registers a listener; resolution is deferred
 *  to a microtask (mirrors the real Tauri `listen()` promise) so StrictMode's
 *  synchronous double-invoke of the effect happens before either promise
 *  settles — the exact race the `cancelled` guard exists for. */
type Handler = (e: AnalysisUpdateEvent) => void;
let registrations: Array<{ cb: Handler; unlisten: ReturnType<typeof vi.fn> }> = [];
const mockOnAnalysisUpdate = vi.fn((cb: Handler) => {
  const unlisten = vi.fn();
  registrations.push({ cb, unlisten });
  return Promise.resolve(unlisten);
});

vi.mock('../bridge/events', () => ({
  onAnalysisUpdate: (cb: Handler) => mockOnAnalysisUpdate(cb),
}));

const mockBusEmit = vi.fn();
vi.mock('../events', () => ({
  bus: { emit: (...args: unknown[]) => mockBusEmit(...args) },
}));

import { AnalysisProvider, useAnalysisContext } from './AnalysisContext';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(AnalysisProvider, null, children);
}

/** Reads the context on every render and reports it out via `onValue` — used
 *  with `render()` (not `renderHook()`) for the StrictMode double-mount
 *  tests below. `renderHook`'s wrapper does not reliably reproduce React's
 *  real double-effect-invoke in this test environment; a plain `render()`
 *  of a StrictMode-wrapped tree does (verified against a throwaway probe:
 *  `render()` shows a mount-effect count of 2 under StrictMode, `renderHook`
 *  shows 1) — so the leak-detection tests render an actual component tree. */
function Capture({ onValue }: { onValue: (v: { artifacts: AnalysisArtifact[]; loading: boolean }) => void }) {
  const ctx = useAnalysisContext();
  onValue(ctx);
  return null;
}

function makeArtifact(overrides: Partial<AnalysisArtifact> = {}): AnalysisArtifact {
  return {
    id: 'art-1',
    title: 'Test analysis',
    createdAt: 1000,
    sections: [],
    ...overrides,
  };
}

/** The single currently-active listener callback (the one not yet unlistened). */
function activeCallback(): Handler {
  const active = registrations.filter((r) => r.unlisten.mock.calls.length === 0);
  expect(active).toHaveLength(1);
  return active[0].cb;
}

beforeEach(() => {
  vi.clearAllMocks();
  registrations = [];
  mockListAnalyses.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------

describe('initial load', () => {
  it('loads the full workspace analysis list on mount', async () => {
    const artifacts = [makeArtifact({ id: 'art-1' }), makeArtifact({ id: 'art-2' })];
    mockListAnalyses.mockResolvedValue(artifacts);

    const { result } = renderHook(() => useAnalysisContext(), { wrapper });

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.artifacts).toEqual(artifacts);
    // No sessionId filter — the full workspace list.
    expect(mockListAnalyses).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// analysis-update event branches
// ---------------------------------------------------------------------------

describe('analysis-update event handling', () => {
  it('deleted removes the artifact by id', async () => {
    mockListAnalyses.mockResolvedValue([makeArtifact({ id: 'art-1' }), makeArtifact({ id: 'art-2' })]);
    const { result } = renderHook(() => useAnalysisContext(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const cb = activeCallback();
    act(() => {
      cb({ artifactId: 'art-1', action: 'deleted', sessionIds: [], sessionId: null });
    });

    expect(result.current.artifacts.map((a) => a.id)).toEqual(['art-2']);
  });

  it('restored re-runs listAnalyses', async () => {
    mockListAnalyses.mockResolvedValueOnce([makeArtifact({ id: 'art-1' })]);
    const { result } = renderHook(() => useAnalysisContext(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const restoredList = [makeArtifact({ id: 'art-9' }), makeArtifact({ id: 'art-10' })];
    mockListAnalyses.mockResolvedValueOnce(restoredList);

    const cb = activeCallback();
    await act(async () => {
      cb({ artifactId: 'irrelevant', action: 'restored', sessionIds: [], sessionId: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual(restoredList);
    });
    expect(mockListAnalyses).toHaveBeenCalledTimes(2);
  });

  it('published fetches the artifact and upserts it as new', async () => {
    mockListAnalyses.mockResolvedValue([]);
    const { result } = renderHook(() => useAnalysisContext(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const published = makeArtifact({ id: 'art-new', title: 'Fresh' });
    mockGetAnalysis.mockResolvedValue(published);

    const cb = activeCallback();
    await act(async () => {
      cb({ artifactId: 'art-new', action: 'published', sessionIds: ['sess-1'], sessionId: 'sess-1' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([published]);
    });
    expect(mockGetAnalysis).toHaveBeenCalledWith('art-new');
  });

  it('updated replaces the matching artifact in place', async () => {
    const original = makeArtifact({ id: 'art-1', title: 'Original' });
    mockListAnalyses.mockResolvedValue([original]);
    const { result } = renderHook(() => useAnalysisContext(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const updated = makeArtifact({ id: 'art-1', title: 'Updated' });
    mockGetAnalysis.mockResolvedValue(updated);

    const cb = activeCallback();
    await act(async () => {
      cb({ artifactId: 'art-1', action: 'updated', sessionIds: [], sessionId: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([updated]);
    });
    expect(result.current.artifacts).toHaveLength(1);
  });

  it.each(['deleted', 'restored', 'published', 'updated'] as const)(
    'emits workspace:mutated with source "artifact" for %s, unconditionally',
    async (action) => {
      mockListAnalyses.mockResolvedValue([makeArtifact({ id: 'art-1' })]);
      mockGetAnalysis.mockResolvedValue(makeArtifact({ id: 'art-1' }));
      const { result } = renderHook(() => useAnalysisContext(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      mockBusEmit.mockClear();
      const cb = activeCallback();
      await act(async () => {
        cb({ artifactId: 'art-1', action, sessionIds: [], sessionId: null });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockBusEmit).toHaveBeenCalledWith('workspace:mutated', { source: 'artifact' });
    },
  );
});

// ---------------------------------------------------------------------------
// StrictMode double-mount — no duplicate/leaked listeners
// ---------------------------------------------------------------------------

describe('StrictMode double-mount', () => {
  it('settles to exactly one active listener after the double-mount race', async () => {
    let latest = { artifacts: [] as AnalysisArtifact[], loading: true };
    const { unmount } = render(
      createElement(
        React.StrictMode,
        null,
        createElement(AnalysisProvider, null, createElement(Capture, { onValue: (v) => { latest = v; } })),
      ),
    );

    await waitFor(() => expect(latest.loading).toBe(false));

    // Both StrictMode mount passes attempted registration...
    expect(mockOnAnalysisUpdate).toHaveBeenCalledTimes(2);
    // ...but only the stale (first) one was torn down once the race settled.
    const unlistenedCount = registrations.filter((r) => r.unlisten.mock.calls.length > 0).length;
    expect(unlistenedCount).toBe(1);
    expect(registrations).toHaveLength(2);

    unmount();
    // The surviving listener is torn down on real unmount — no leak.
    const totalUnlistened = registrations.filter((r) => r.unlisten.mock.calls.length > 0).length;
    expect(totalUnlistened).toBe(2);
  });

  it('the single active listener still drives state correctly post-settle', async () => {
    mockListAnalyses.mockResolvedValue([makeArtifact({ id: 'art-1' }), makeArtifact({ id: 'art-2' })]);
    let latest = { artifacts: [] as AnalysisArtifact[], loading: true };
    render(
      createElement(
        React.StrictMode,
        null,
        createElement(AnalysisProvider, null, createElement(Capture, { onValue: (v) => { latest = v; } })),
      ),
    );

    await waitFor(() => expect(latest.loading).toBe(false));

    const cb = activeCallback();
    act(() => {
      cb({ artifactId: 'art-1', action: 'deleted', sessionIds: [], sessionId: null });
    });

    await waitFor(() => {
      expect(latest.artifacts.map((a) => a.id)).toEqual(['art-2']);
    });
  });
});
