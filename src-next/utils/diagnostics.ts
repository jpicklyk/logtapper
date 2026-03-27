/**
 * Diagnostic logging for the file loading pipeline.
 *
 * Enable via: localStorage.setItem('logtapper_diag', '1')
 * Disable via: localStorage.removeItem('logtapper_diag')
 *
 * Covers the full data flow:
 *   loadFile → backend IPC → registerSession → activateSessionForPane →
 *   session:loaded → cache allocateView → DataSource → FetchScheduler →
 *   getLines IPC → cache put → virtualizer render
 *
 * Each log entry includes a high-resolution timestamp delta from the
 * start of the current operation, making it easy to spot where time is spent.
 */

import { storageGet } from '../utils';

const isEnabled = () =>
  import.meta.env.DEV || storageGet('logtapper_diag') === '1';

let _enabled: boolean | null = null;
function enabled(): boolean {
  if (_enabled === null) _enabled = isEnabled();
  return _enabled;
}

/** Force re-check of the enabled flag (e.g., after localStorage change). */
export function diagRefresh(): void {
  _enabled = null;
}

// ── Timing ──────────────────────────────────────────────────────────────

const timers = new Map<string, number>();

/** Start a named timer. */
export function diagStart(label: string): void {
  if (!enabled()) return;
  timers.set(label, performance.now());
  console.debug(
    `%c[diag] %c▸ ${label}`,
    'color:#666',
    'color:#f0a500;font-weight:bold',
  );
}

/** End a named timer and log the elapsed time. */
export function diagEnd(label: string): void {
  if (!enabled()) return;
  const start = timers.get(label);
  timers.delete(label);
  const elapsed = start != null ? (performance.now() - start).toFixed(1) : '?';
  console.debug(
    `%c[diag] %c◂ ${label} %c${elapsed}ms`,
    'color:#666',
    'color:#3fb950;font-weight:bold',
    'color:#58a6ff',
  );
}

// ── Checkpoint logging ──────────────────────────────────────────────────

type DiagCategory =
  | 'file-load'
  | 'session'
  | 'cache'
  | 'fetch'
  | 'render'
  | 'context'
  | 'bus';

const CATEGORY_COLORS: Record<DiagCategory, string> = {
  'file-load': '#f0a500',
  session: '#58a6ff',
  cache: '#3fb950',
  fetch: '#c084fc',
  render: '#f47067',
  context: '#60a5fa',
  bus: '#2dd4bf',
};

/**
 * Log a diagnostic checkpoint.
 *
 * @param category  Pipeline stage
 * @param message   What happened
 * @param data      Optional structured data (session IDs, line counts, etc.)
 */
export function diag(category: DiagCategory, message: string, data?: Record<string, unknown>): void {
  if (!enabled()) return;
  const color = CATEGORY_COLORS[category];
  const label = `%c[diag] %c[${category}] %c${message}`;
  if (data) {
    console.debug(label, 'color:#666', `color:${color};font-weight:bold`, 'color:inherit', data);
  } else {
    console.debug(label, 'color:#666', `color:${color};font-weight:bold`, 'color:inherit');
  }
}
