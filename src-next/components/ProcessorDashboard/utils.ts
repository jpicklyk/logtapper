// ── Var rendering helpers ────────────────────────────────────────────────────

export function isNumeric(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

export function isRankedObject(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(isNumeric);
}

export { formatNumber } from '../../utils';

export function snakeToTitle(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface VarGroup {
  scalars: Array<{ name: string; value: number }>;
  strings: Array<{ name: string; value: string }>;
  ranked: Array<{ name: string; value: Record<string, number> }>;
  tables: Array<{ name: string; value: Record<string, unknown>[] }>;
  other: Array<{ name: string; value: unknown }>;
}

export function groupVars(vars: Record<string, unknown>): VarGroup {
  const g: VarGroup = { scalars: [], strings: [], ranked: [], tables: [], other: [] };
  for (const [name, value] of Object.entries(vars)) {
    if (isNumeric(value)) {
      g.scalars.push({ name, value });
    } else if (typeof value === 'string') {
      g.strings.push({ name, value });
    } else if (isRankedObject(value)) {
      g.ranked.push({ name, value });
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      g.tables.push({ name, value: value as Record<string, unknown>[] });
    } else {
      g.other.push({ name, value });
    }
  }
  return g;
}

// Detect "value | description" pattern used by annotated map vars (e.g. resolver experiments).
// Returns null if the separator is absent so normal rendering is used.
export function splitValueDesc(raw: string): { value: string; desc: string } | null {
  const idx = raw.indexOf(' | ');
  if (idx === -1) return null;
  return { value: raw.slice(0, idx), desc: raw.slice(idx + 3) };
}

export interface DashboardPackGroup {
  packId: string;
  packName: string;
  processors: import('../../bridge/types').ProcessorSummary[];
}
