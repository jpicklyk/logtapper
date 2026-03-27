/**
 * Velocity-aware fetch scheduler.
 *
 * Skips fetches during fast scrolling and triggers on settle (~100ms pause
 * or velocity drops below threshold). Supports directional prefetch with
 * separate viewport and prefetch ranges.
 */

/** A contiguous range of lines. */
export interface FetchRange {
  offset: number;
  count: number;
}

/** Configuration for the FetchScheduler. */
export interface FetchSchedulerConfig {
  /** Minimum ms between scroll position updates to consider "settled". */
  settleMs?: number;
  /** Max velocity (lines/ms) above which fetches are suppressed. */
  velocityThreshold?: number;
  /** Number of lines to prefetch in the scroll direction. */
  prefetchLines?: number;
}

const DEFAULT_SETTLE_MS = 100;
const DEFAULT_VELOCITY_THRESHOLD = 5; // lines per ms
const DEFAULT_PREFETCH_LINES = 5000;

/**
 * Callback receives two ranges:
 * - viewport: the currently visible lines (always fetched)
 * - prefetch: extended range in the scroll direction (fetched when allowed)
 */
export type FetchCallback = (viewport: FetchRange, prefetch: FetchRange) => void;

export class FetchScheduler {
  private _settleMs: number;
  private _velocityThreshold: number;
  private _prefetchLines: number;

  private _lastScrollTime = 0;
  private _lastScrollPos = 0;
  private _velocity = 0;
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingViewport: FetchRange | null = null;
  private _pendingPrefetch: FetchRange | null = null;
  private _lastFetchedViewport: FetchRange | null = null;
  private _lastFetchedPrefetch: FetchRange | null = null;
  private _fetchCb: FetchCallback | null = null;
  private _disposed = false;

  constructor(config: FetchSchedulerConfig = {}) {
    this._settleMs = config.settleMs ?? DEFAULT_SETTLE_MS;
    this._velocityThreshold = config.velocityThreshold ?? DEFAULT_VELOCITY_THRESHOLD;
    this._prefetchLines = config.prefetchLines ?? DEFAULT_PREFETCH_LINES;
  }

  get velocity(): number {
    return this._velocity;
  }

  /** Update the prefetch line count at runtime (e.g., when cache allocation changes).
   *  Floors at 500 to ensure a meaningful prefetch even with small allocations. */
  setPrefetchLines(n: number): void {
    this._prefetchLines = Math.max(n, 500);
  }

  get isSettled(): boolean {
    return this._velocity < this._velocityThreshold;
  }

  get pendingFetch(): FetchRange | null {
    return this._pendingViewport;
  }

  /** Register the function called when a fetch should be issued. */
  onFetch(cb: FetchCallback): void {
    this._fetchCb = cb;
  }

  /**
   * Report a scroll position update. The scheduler tracks velocity and
   * decides whether to fetch immediately or defer.
   *
   * @param firstVisible - First visible line number
   * @param lastVisible - Last visible line number
   * @param totalLines - Total lines in the view
   */
  reportScroll(firstVisible: number, lastVisible: number, totalLines: number): void {
    if (this._disposed) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = now - this._lastScrollTime;

    // Compute direction BEFORE updating _lastScrollPos
    const direction = firstVisible >= this._lastScrollPos ? 1 : -1;
    const dp = Math.abs(firstVisible - this._lastScrollPos);

    if (dt > 0) {
      this._velocity = dp / dt;
    }

    this._lastScrollTime = now;
    this._lastScrollPos = firstVisible;

    // Asymmetric prefetch: more lines ahead in scroll direction, fewer behind
    const ahead = this._prefetchLines;
    const behind = Math.floor(this._prefetchLines * 0.25);

    // Viewport range — exactly what's visible
    const vpOffset = firstVisible;
    const vpCount = lastVisible - firstVisible + 1;
    this._pendingViewport = { offset: vpOffset, count: vpCount };

    // Prefetch range — extends in scroll direction
    let pfStart: number;
    let pfEnd: number;
    if (direction >= 0) {
      // Scrolling down: prefetch more below, less above
      pfStart = Math.max(0, firstVisible - behind);
      pfEnd = Math.min(totalLines, lastVisible + ahead);
    } else {
      // Scrolling up: prefetch more above, less below
      pfStart = Math.max(0, firstVisible - ahead);
      pfEnd = Math.min(totalLines, lastVisible + behind);
    }
    this._pendingPrefetch = { offset: pfStart, count: pfEnd - pfStart };

    // Clear any existing settle timer
    if (this._settleTimer !== null) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }

    // If velocity is below threshold, fetch immediately
    if (this._velocity < this._velocityThreshold) {
      this._executeFetch();
      return;
    }

    // Otherwise, defer until settled
    this._settleTimer = setTimeout(() => {
      this._velocity = 0; // Considered settled after the timer fires
      this._executeFetch();
    }, this._settleMs);
  }

  /** Force a fetch bypassing velocity checks and dedup. */
  forceFetch(): void {
    if (this._disposed) return;
    // Clear dedup so the next execute always fires
    this._lastFetchedViewport = null;
    this._lastFetchedPrefetch = null;
    this._executeFetch();
  }

  /** Clean up timers. */
  dispose(): void {
    this._disposed = true;
    if (this._settleTimer !== null) {
      clearTimeout(this._settleTimer);
      this._settleTimer = null;
    }
    this._fetchCb = null;
  }

  private _rangesEqual(a: FetchRange | null, b: FetchRange | null): boolean {
    if (a === null || b === null) return a === b;
    return a.offset === b.offset && a.count === b.count;
  }

  private _executeFetch(): void {
    if (!this._pendingViewport || !this._pendingPrefetch || !this._fetchCb) return;

    // Dedup: skip if both ranges match the last fetch
    if (
      this._rangesEqual(this._pendingViewport, this._lastFetchedViewport) &&
      this._rangesEqual(this._pendingPrefetch, this._lastFetchedPrefetch)
    ) {
      return;
    }

    const viewport = this._pendingViewport;
    const prefetch = this._pendingPrefetch;
    this._lastFetchedViewport = { ...viewport };
    this._lastFetchedPrefetch = { ...prefetch };
    this._pendingViewport = null;
    this._pendingPrefetch = null;
    this._fetchCb(viewport, prefetch);
  }
}
