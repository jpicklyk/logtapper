import type { ViewLine } from '../bridge/types';

/** Priority tiers for cache allocation. */
export type ViewPriority = 'focused' | 'visible' | 'background';

/** Budget fractions per priority tier. */
const PRIORITY_FRACTIONS: Record<ViewPriority, number> = {
  focused: 0.6,
  visible: 0.3,
  background: 0.1,
};

/** Minimum lines a view is guaranteed even in the lowest tier. */
const MIN_FLOOR = 2000;

/**
 * A handle to a single view's slice of the global cache.
 * Keyed by actual file line number (works across filter transitions).
 */
export class ViewCacheHandle {
  private _cache = new Map<number, ViewLine>();
  private _allocation: number;
  private _accessOrder: number[] = []; // LRU tracking — most recent at end

  constructor(allocation: number) {
    this._allocation = Math.max(allocation, MIN_FLOOR);
  }

  get size(): number {
    return this._cache.size;
  }

  get allocation(): number {
    return this._allocation;
  }

  /** Look up a cached line. Returns undefined on miss. */
  get(lineNumber: number): ViewLine | undefined {
    const line = this._cache.get(lineNumber);
    if (line !== undefined) {
      // Move to end of access order (most recently used)
      const idx = this._accessOrder.indexOf(lineNumber);
      if (idx !== -1) {
        this._accessOrder.splice(idx, 1);
      }
      this._accessOrder.push(lineNumber);
    }
    return line;
  }

  /** Insert lines into the cache. Evicts LRU entries if over allocation. */
  put(lines: ViewLine[]): void {
    for (const line of lines) {
      if (!this._cache.has(line.lineNum)) {
        this._cache.set(line.lineNum, line);
        this._accessOrder.push(line.lineNum);
      } else {
        // Update existing entry, refresh access order
        this._cache.set(line.lineNum, line);
        const idx = this._accessOrder.indexOf(line.lineNum);
        if (idx !== -1) this._accessOrder.splice(idx, 1);
        this._accessOrder.push(line.lineNum);
      }
    }
    this._evict();
  }

  /** Whether the cache has room for more lines (not at allocation limit). */
  prefetchAllowed(): boolean {
    return this._cache.size < this._allocation;
  }

  /** Update the allocation budget. Evicts if over the new budget. */
  setAllocation(n: number): void {
    this._allocation = Math.max(n, MIN_FLOOR);
    this._evict();
  }

  /** Clear all cached lines. */
  clear(): void {
    this._cache.clear();
    this._accessOrder = [];
  }

  /** Check if a line is cached (without updating LRU). */
  has(lineNumber: number): boolean {
    return this._cache.has(lineNumber);
  }

  /** Iterate all cached entries (for migration / debugging). */
  entries(): IterableIterator<[number, ViewLine]> {
    return this._cache.entries();
  }

  private _evict(): void {
    while (this._cache.size > this._allocation && this._accessOrder.length > 0) {
      const oldest = this._accessOrder.shift()!;
      this._cache.delete(oldest);
    }
  }
}

/**
 * Global cache manager that distributes a shared line budget across views.
 *
 * Usage:
 *   const mgr = new CacheManager(100_000);
 *   const handle = mgr.allocateView('pane-1-sess-abc', 'sess-abc');
 *   mgr.setFocus('pane-1-sess-abc');
 *   handle.put(lines);
 *   handle.get(42);
 *   mgr.releaseView('pane-1-sess-abc');
 *
 * Multi-consumer streaming:
 *   mgr.broadcastToSession('sess-abc', lines);  // writes to ALL handles for that session
 */
export class CacheManager {
  private _totalBudget: number;
  private _views = new Map<string, { handle: ViewCacheHandle; priority: ViewPriority; sessionId: string | null }>();
  private _focusedId: string | null = null;

  constructor(totalBudget: number = 100_000) {
    this._totalBudget = totalBudget;
  }

  get totalBudget(): number {
    return this._totalBudget;
  }

  get viewCount(): number {
    return this._views.size;
  }

  /** Create a new view handle and allocate cache budget for it.
   *  @param sessionId  Optional session ID — enables broadcastToSession(). */
  allocateView(viewId: string, sessionId?: string): ViewCacheHandle {
    if (this._views.has(viewId)) {
      return this._views.get(viewId)!.handle;
    }
    const priority: ViewPriority = this._focusedId === null ? 'focused' : 'visible';
    const handle = new ViewCacheHandle(MIN_FLOOR);
    this._views.set(viewId, { handle, priority, sessionId: sessionId ?? null });
    if (this._focusedId === null) {
      this._focusedId = viewId;
    }
    this._redistribute();
    return handle;
  }

  /** Release a view and reclaim its budget. */
  releaseView(viewId: string): void {
    const entry = this._views.get(viewId);
    if (!entry) return;
    entry.handle.clear();
    this._views.delete(viewId);
    if (this._focusedId === viewId) {
      this._focusedId = null;
      // Pick next view as focused if available
      const first = this._views.keys().next();
      if (!first.done) {
        this._focusedId = first.value;
      }
    }
    this._redistribute();
  }

  /** Change which view gets the focused (largest) allocation. */
  setFocus(viewId: string): void {
    if (!this._views.has(viewId)) return;
    if (this._focusedId === viewId) return;
    this._focusedId = viewId;
    this._redistribute();
  }

  /** Get the handle for a view. */
  getHandle(viewId: string): ViewCacheHandle | undefined {
    return this._views.get(viewId)?.handle;
  }

  /** Update the total budget. Redistributes immediately. */
  setTotalBudget(budget: number): void {
    this._totalBudget = budget;
    this._redistribute();
  }

  /** Get the current priority for a view. */
  getPriority(viewId: string): ViewPriority | undefined {
    return this._views.get(viewId)?.priority;
  }

  /** Write lines into ALL handles that belong to the given session. */
  broadcastToSession(sessionId: string, lines: ViewLine[]): void {
    for (const [, entry] of this._views) {
      if (entry.sessionId === sessionId) {
        entry.handle.put(lines);
      }
    }
  }

  /** Return an iterable of cached entries from the largest handle for the session.
   *  Useful for filter scanning in streaming mode. */
  getSessionEntries(sessionId: string): IterableIterator<[number, ViewLine]> {
    let best: ViewCacheHandle | null = null;
    let bestSize = -1;
    for (const [, entry] of this._views) {
      if (entry.sessionId === sessionId && entry.handle.size > bestSize) {
        best = entry.handle;
        bestSize = entry.handle.size;
      }
    }
    if (best) return best.entries();
    // Return an empty iterator
    return (new Map<number, ViewLine>()).entries();
  }

  /** Clear all handles that belong to the given session. */
  clearSession(sessionId: string): void {
    for (const [, entry] of this._views) {
      if (entry.sessionId === sessionId) {
        entry.handle.clear();
      }
    }
  }

  /**
   * Redistribute budget across all views based on priorities.
   * Focused: 60%, Visible (non-focused): 30% shared, Background: 10% shared.
   */
  private _redistribute(): void {
    if (this._views.size === 0) return;

    // Classify views
    const focused: string[] = [];
    const visible: string[] = [];
    const background: string[] = [];

    for (const [id] of this._views) {
      if (id === this._focusedId) {
        focused.push(id);
      } else {
        // Non-focused views default to 'visible' unless explicitly set
        const entry = this._views.get(id)!;
        if (entry.priority === 'background') {
          background.push(id);
        } else {
          visible.push(id);
        }
      }
    }

    // Update priorities
    for (const id of focused) this._views.get(id)!.priority = 'focused';
    for (const id of visible) this._views.get(id)!.priority = 'visible';
    for (const id of background) this._views.get(id)!.priority = 'background';

    // Single-view optimization: give it the full budget
    if (this._views.size === 1) {
      const [, entry] = [...this._views.entries()][0];
      entry.handle.setAllocation(this._totalBudget);
      return;
    }

    // Compute allocations
    const focusedBudget = Math.floor(this._totalBudget * PRIORITY_FRACTIONS.focused);
    const visibleBudget = Math.floor(this._totalBudget * PRIORITY_FRACTIONS.visible);
    const backgroundBudget = Math.floor(this._totalBudget * PRIORITY_FRACTIONS.background);

    for (const id of focused) {
      this._views.get(id)!.handle.setAllocation(focusedBudget);
    }

    const perVisible = visible.length > 0 ? Math.floor(visibleBudget / visible.length) : 0;
    for (const id of visible) {
      this._views.get(id)!.handle.setAllocation(perVisible);
    }

    const perBackground = background.length > 0 ? Math.floor(backgroundBudget / background.length) : 0;
    for (const id of background) {
      this._views.get(id)!.handle.setAllocation(perBackground);
    }
  }
}
