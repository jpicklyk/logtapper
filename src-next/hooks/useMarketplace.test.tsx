// @vitest-environment jsdom
/**
 * Tests for useMarketplace's return-value memoization (U22).
 *
 * useMarketplace used to return a fresh object literal on every render,
 * defeating React.memo on BrowseTab/UpdatesTab/SourcesTab which receive the
 * whole `marketplace` object as a prop (MarketplacePanel.tsx). Wrapping the
 * return in useMemo (keyed on its state — the callbacks are already
 * useCallback-stable) means an unrelated re-render of the owning component
 * (e.g. MarketplacePanel's local `tab` state) must not produce a new
 * `marketplace` object reference.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';
import { MarketplaceProvider } from '../context/MarketplaceContext';
import { useMarketplace } from './useMarketplace';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(MarketplaceProvider, null, children);
}

describe('useMarketplace — return value memoization', () => {
  it('returns the same object reference across an unrelated re-render', () => {
    const { result, rerender } = renderHook(() => useMarketplace(), { wrapper });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });

  it('is stable even when the owning component re-renders due to unrelated local state', () => {
    // Mirrors MarketplacePanel: useMarketplace() called alongside a local
    // `tab` useState that changes on user interaction.
    const { result } = renderHook(
      () => {
        const marketplace = useMarketplace();
        const [tab, setTab] = useState('browse');
        return { marketplace, tab, setTab };
      },
      { wrapper },
    );

    const firstMarketplace = result.current.marketplace;

    act(() => {
      result.current.setTab('updates');
    });

    expect(result.current.tab).toBe('updates');
    expect(result.current.marketplace).toBe(firstMarketplace);
  });
});
