import type { ViewLine } from '../bridge/types';
import type { CacheDataSource } from './CacheDataSource';

/**
 * Narrow interface for pushing streaming lines into registered data sources.
 * Used by hooks that only need to push lines (e.g., useLogViewer).
 */
export interface StreamPusher {
  pushToSession(sessionId: string, lines: ViewLine[], totalLines: number): void;
}

/**
 * Interface for data source lifecycle management.
 * Used by createCacheDataSource for register/unregister + streaming push.
 */
export interface DataSourceRegistrar extends StreamPusher {
  register(sessionId: string, ds: CacheDataSource): void;
  unregister(sessionId: string, ds: CacheDataSource): void;
}

/**
 * Registry of active CacheDataSource instances, keyed by session ID.
 *
 * Used by the streaming handler to push new lines into ALL active
 * CacheDataSources for a session (firing their onAppend listeners),
 * alongside the CacheManager.broadcastToSession() call that populates
 * the ViewCacheHandle LRU.
 */
export class DataSourceRegistry implements DataSourceRegistrar {
  private _sources = new Map<string, Set<CacheDataSource>>();

  register(sessionId: string, ds: CacheDataSource): void {
    let set = this._sources.get(sessionId);
    if (!set) {
      set = new Set();
      this._sources.set(sessionId, set);
    }
    set.add(ds);
  }

  unregister(sessionId: string, ds: CacheDataSource): void {
    const set = this._sources.get(sessionId);
    if (!set) return;
    set.delete(ds);
    if (set.size === 0) {
      this._sources.delete(sessionId);
    }
  }

  /**
   * Push streaming lines into all registered CacheDataSources for the session.
   * This fires their onAppend listeners, enabling tail-mode auto-scroll.
   */
  pushToSession(sessionId: string, lines: ViewLine[], totalLines: number): void {
    const set = this._sources.get(sessionId);
    if (!set) return;
    for (const ds of set) {
      ds.pushStreamingLines(lines, totalLines);
    }
  }
}
