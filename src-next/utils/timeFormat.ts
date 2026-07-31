// ---------------------------------------------------------------------------
// Shared nanosecond timestamp + duration formatting.
//
// Timestamp formatting stays as two distinct functions — they serve genuinely
// different UI needs (a full localized date/time for a summary stat vs. a
// compact UTC clock label for dense timeline ticks) — but both live here so a
// future caller finds them instead of writing a third version.
//
// Duration formatting is consolidated into a single convention
// (`formatDurationNs`): composite units (e.g. "3m 12s") for the coarse
// FileInfoPanel case, with a microsecond branch layered on for spans under
// 1ms that the coarse convention alone would round down to "0ms". See
// `formatDurationBetween` for the two-absolute-timestamps variant.
// ---------------------------------------------------------------------------

/** Format an absolute nanosecond timestamp as a full localized date/time
 *  (e.g. "Nov 14, 22:13:20"). Returns an em-dash placeholder for null/zero. */
export function formatTimestamp(ns: number | null | undefined): string {
  if (ns === null || ns === undefined || ns === 0) return '—';
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toLocaleString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Format an absolute nanosecond timestamp as a compact UTC clock label
 *  ("14:25:36.789"), optionally prefixed with zero-padded MM-DD for
 *  timelines spanning multiple days. */
export function formatTimestampCompact(tsNanos: number, includeDate = false): string {
  const d = new Date(tsNanos / 1_000_000);
  const time = [
    d.getUTCHours().toString().padStart(2, '0'),
    d.getUTCMinutes().toString().padStart(2, '0'),
    d.getUTCSeconds().toString().padStart(2, '0'),
  ].join(':') + '.' + d.getUTCMilliseconds().toString().padStart(3, '0');
  if (!includeDate) return time;
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${month}-${day} ${time}`;
}

/**
 * Format a duration given directly in nanoseconds. Sub-millisecond spans
 * (<1ms) show one decimal of microseconds; everything else uses composite
 * units: "Nms", "N.Ns", "Nm Ns", "Nh Nm", "Nd Nh".
 */
export function formatDurationNs(nanos: number): string {
  if (nanos < 1_000_000) return `${(nanos / 1_000).toFixed(1)}us`;
  const diffMs = Math.floor(nanos / 1_000_000);
  if (diffMs < 1000) return `${diffMs}ms`;
  if (diffMs < 60_000) return `${(diffMs / 1000).toFixed(1)}s`;
  if (diffMs < 3_600_000) {
    const m = Math.floor(diffMs / 60_000);
    const s = Math.floor((diffMs % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  if (diffMs < 86_400_000) {
    const h = Math.floor(diffMs / 3_600_000);
    const m = Math.floor((diffMs % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(diffMs / 86_400_000);
  const h = Math.floor((diffMs % 86_400_000) / 3_600_000);
  return `${d}d ${h}h`;
}

/**
 * Format the elapsed time between two absolute nanosecond timestamps.
 * Returns null if either timestamp is missing/zero or the range is inverted.
 */
export function formatDurationBetween(
  startNs: number | null | undefined,
  endNs: number | null | undefined,
): string | null {
  if (!startNs || !endNs || startNs === 0 || endNs === 0) return null;
  const diffNs = endNs - startNs;
  if (diffNs < 0) return null;
  return formatDurationNs(diffNs);
}
