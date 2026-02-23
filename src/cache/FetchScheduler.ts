/**
 * Velocity-aware fetch scheduler.
 *
 * Skips fetches during fast scrolling and triggers on settle (~100ms pause
 * or velocity drops below threshold). Supports directional prefetch.
 */

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
const DEFAULT_PREFETCH_LINES = 2000;

export type FetchCallback = (offset: number, count: number) => void;

export class FetchScheduler {
  private _settleMs: number;
  private _velocityThreshold: number;
  private _prefetchLines: number;

  private _lastScrollTime = 0;
  private _lastScrollPos = 0;
  private _velocity = 0;
  private _settleTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingFetch: { offset: number; count: number } | null = null;
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

  get isSettled(): boolean {
    return this._velocity < this._velocityThreshold;
  }

  get pendingFetch(): { offset: number; count: number } | null {
    return this._pendingFetch;
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
    const dp = Math.abs(firstVisible - this._lastScrollPos);

    if (dt > 0) {
      this._velocity = dp / dt;
    }

    this._lastScrollTime = now;
    this._lastScrollPos = firstVisible;

    // Compute the desired fetch range with prefetch
    const direction = firstVisible >= this._lastScrollPos ? 1 : -1;
    const prefetchAhead = direction === 1
      ? this._prefetchLines
      : this._prefetchLines;

    const fetchOffset = Math.max(0, firstVisible - this._prefetchLines);
    const fetchEnd = Math.min(totalLines, lastVisible + prefetchAhead);
    const fetchCount = fetchEnd - fetchOffset;

    this._pendingFetch = { offset: fetchOffset, count: fetchCount };

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

  /** Force a fetch at the given range, bypassing velocity checks. */
  forceFetch(offset: number, count: number): void {
    if (this._disposed) return;
    this._pendingFetch = { offset, count };
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

  private _executeFetch(): void {
    if (!this._pendingFetch || !this._fetchCb) return;
    const { offset, count } = this._pendingFetch;
    this._pendingFetch = null;
    this._fetchCb(offset, count);
  }
}
