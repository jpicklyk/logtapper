// ---------------------------------------------------------------------------
// Shared utilities — pure functions with no module dependencies
// ---------------------------------------------------------------------------

/** Clamp a number between min and max (inclusive). */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** Extract the filename from a path (handles both / and \ separators). */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Extract the parent directory from a path (handles both / and \ separators). */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : path;
}

// ---------------------------------------------------------------------------
// localStorage helpers — wrap try/catch so callers don't need to
// ---------------------------------------------------------------------------

/** Read a string from localStorage, returning `fallback` on any error. */
export function storageGet(key: string, fallback: string = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Write a string to localStorage, silently swallowing quota errors. */
export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage full or unavailable
  }
}

/** Remove a key from localStorage, silently swallowing errors. */
export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // unavailable
  }
}

/** Read and JSON.parse a value, returning `fallback` on any error. */
export function storageGetJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** JSON.stringify and write a value to localStorage. */
export function storageSetJSON<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable
  }
}

/** Format a number with locale-appropriate separators and up to 2 decimal places. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Format a byte count as a human-readable string (B, KB, MB, GB). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
