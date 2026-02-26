import type { ViewLine } from '../bridge/types';

/** Priority tiers for cache allocation. */
export type ViewPriority = 'focused' | 'visible' | 'background';

// ── Public interfaces (narrow API surface) ────────────────────────────

/** Read-only view of a cache handle. For components that display cached lines. */
export interface ViewCache {
  readonly size: number;
  readonly allocation: number;
  get(lineNumber: number): ViewLine | undefined;
  has(lineNumber: number): boolean;
  prefetchAllowed(): boolean;
}

/** Writable view of a cache handle. For CacheDataSource (stores fetched lines). */
export interface WritableViewCache extends ViewCache {
  put(lines: ViewLine[]): void;
}

/** Narrow controller interface for hooks that manage streaming data. */
export interface CacheController {
  broadcastToSession(sessionId: string, lines: ViewLine[]): void;
  clearSession(sessionId: string): void;
  /**
   * Release (clear + remove from budget tracking) all view handles for a session.
   * Call when a session is permanently closed — tab close, file replacement, stream stop.
   * This frees the budget those handles were consuming so other views can grow.
   */
  releaseSessionViews(sessionId: string): void;
  getSessionEntries(sessionId: string): IterableIterator<[number, ViewLine]>;
  setTotalBudget(budget: number): void;
}

/** Budget fractions per priority tier. */
const PRIORITY_FRACTIONS: Record<ViewPriority, number> = {
  focused: 0.6,
  visible: 0.3,
  background: 0.1,
};

/** Minimum lines a view is guaranteed even in the lowest tier. */
const MIN_FLOOR = 2000;

/** Doubly-linked list node for O(1) LRU tracking. */
interface LruNode {
  key: number;
  prev: LruNode | null;
  next: LruNode | null;
}

/** Typed empty iterator — avoids allocating a new Map on every call. */
function* emptyIterator(): IterableIterator<[number, ViewLine]> {
  // yields nothing
}

/**
 * A handle to a single view's slice of the global cache.
 * Keyed by actual file line number (works across filter transitions).
 *
 * LRU tracking uses a doubly-linked list + Map for O(1) get/put/evict.
 */
export class ViewCacheHandle implements WritableViewCache {
  private _cache = new Map<number, ViewLine>();
  private _allocation: number;
  // O(1) LRU: doubly-linked list with Map for node lookup
  private _orderMap = new Map<number, LruNode>();
  private _head: LruNode | null = null; // least recently used
  private _tail: LruNode | null = null; // most recently used

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
      this._promote(lineNumber);
    }
    return line;
  }

  /** Insert lines into the cache. Evicts LRU entries if over allocation. */
  put(lines: ViewLine[]): void {
    for (const line of lines) {
      if (this._cache.has(line.lineNum)) {
        // Update existing entry, promote in LRU
        this._cache.set(line.lineNum, line);
        this._promote(line.lineNum);
      } else {
        // New entry — append at tail
        this._cache.set(line.lineNum, line);
        this._appendNode(line.lineNum);
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
    this._orderMap.clear();
    this._head = null;
    this._tail = null;
  }

  /** Check if a line is cached (without updating LRU). */
  has(lineNumber: number): boolean {
    return this._cache.has(lineNumber);
  }

  /** Iterate all cached entries (for migration / debugging). */
  entries(): IterableIterator<[number, ViewLine]> {
    return this._cache.entries();
  }

  /** Move an existing node to the tail (most recently used). O(1). */
  private _promote(key: number): void {
    const node = this._orderMap.get(key);
    if (!node || node === this._tail) return;
    this._unlinkNode(node);
    this._linkAtTail(node);
  }

  /** Create a new node and append at tail. O(1). */
  private _appendNode(key: number): void {
    const node: LruNode = { key, prev: null, next: null };
    this._orderMap.set(key, node);
    this._linkAtTail(node);
  }

  /** Link a node at the tail of the list. */
  private _linkAtTail(node: LruNode): void {
    node.next = null;
    node.prev = this._tail;
    if (this._tail) {
      this._tail.next = node;
    } else {
      this._head = node;
    }
    this._tail = node;
  }

  /** Unlink a node from the list (does not remove from _orderMap). */
  private _unlinkNode(node: LruNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this._head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this._tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  /** Evict from head (LRU) until within allocation. O(1) per eviction. */
  private _evict(): void {
    while (this._cache.size > this._allocation && this._head) {
      const node = this._head;
      this._head = node.next;
      if (this._head) {
        this._head.prev = null;
      } else {
        this._tail = null;
      }
      this._cache.delete(node.key);
      this._orderMap.delete(node.key);
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
export class CacheManager implements CacheController {
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
      console.debug('[CacheManager] allocateView: returning existing handle', { viewId, sessionId });
      return this._views.get(viewId)!.handle;
    }
    const priority: ViewPriority = this._focusedId === null ? 'focused' : 'visible';
    console.debug('[CacheManager] allocateView: creating new handle', { viewId, sessionId, priority, focusedId: this._focusedId, viewCount: this._views.size });
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
    if (!entry) {
      console.debug('[CacheManager] releaseView: viewId not found (already released?)', { viewId });
      return;
    }
    console.debug('[CacheManager] releaseView', { viewId, cacheSize: entry.handle.size, sessionId: entry.sessionId });
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
    let handleCount = 0;
    for (const [viewId, entry] of this._views) {
      if (entry.sessionId === sessionId) {
        entry.handle.put(lines);
        handleCount++;
      }
    }
    if (handleCount === 0) {
      console.warn('[CacheManager] broadcastToSession: NO handles found for session', { sessionId, viewCount: this._views.size });
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
    return emptyIterator();
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
   * Release (clear + remove from budget tracking) all view handles for a session.
   * Call when a session is permanently closed — tab close, file replacement, stream stop.
   * This frees the budget those handles were consuming so other views can grow.
   */
  releaseSessionViews(sessionId: string): void {
    const idsToRelease: string[] = [];
    for (const [viewId, entry] of this._views) {
      if (entry.sessionId === sessionId) {
        idsToRelease.push(viewId);
      }
    }
    for (const viewId of idsToRelease) {
      this.releaseView(viewId);
    }
  }

  /**
   * Redistribute budget across all views based on priorities.
   * Focused: 60%, Visible (non-focused): 30% shared, Background: 10% shared.
   * Accounts for MIN_FLOOR enforcement to avoid exceeding total budget.
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
      this._views.values().next().value!.handle.setAllocation(this._totalBudget);
      return;
    }

    // Compute raw allocations
    const focusedBudget = Math.floor(this._totalBudget * PRIORITY_FRACTIONS.focused);
    const visibleBudget = Math.floor(this._totalBudget * PRIORITY_FRACTIONS.visible);
    const backgroundBudget = Math.floor(this._totalBudget * PRIORITY_FRACTIONS.background);

    const perVisible = visible.length > 0 ? Math.floor(visibleBudget / visible.length) : 0;
    const perBackground = background.length > 0 ? Math.floor(backgroundBudget / background.length) : 0;

    // Account for MIN_FLOOR clamping: count how many non-focused views
    // will be clamped up to the floor and compute the overshoot.
    let floorOvershoot = 0;
    if (perVisible < MIN_FLOOR) {
      floorOvershoot += visible.length * (MIN_FLOOR - perVisible);
    }
    if (perBackground < MIN_FLOOR) {
      floorOvershoot += background.length * (MIN_FLOOR - perBackground);
    }

    // Reduce focused allocation to absorb the floor overshoot (down to its own floor)
    const adjustedFocused = Math.max(MIN_FLOOR, focusedBudget - floorOvershoot);

    for (const id of focused) {
      this._views.get(id)!.handle.setAllocation(adjustedFocused);
    }
    for (const id of visible) {
      this._views.get(id)!.handle.setAllocation(perVisible);
    }
    for (const id of background) {
      this._views.get(id)!.handle.setAllocation(perBackground);
    }
  }
}
