import type { StateTransition } from '../../bridge/types';
import { clamp } from '../../utils';

export type Viewport = readonly [number, number];

export interface TrackerTimeline {
  trackerId: string;
  trackerName: string;
  transitions: StateTransition[];
}

export function formatTs(tsNanos: number, includeDate = false): string {
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

export function fmtDuration(nanos: number): string {
  if (nanos < 1e6) return `${(nanos / 1e3).toFixed(1)}us`;
  if (nanos < 1e9) return `${(nanos / 1e6).toFixed(0)}ms`;
  if (nanos < 60e9) return `${(nanos / 1e9).toFixed(2)}s`;
  if (nanos < 3600e9) return `${(nanos / 60e9).toFixed(1)}m`;
  return `${(nanos / 3600e9).toFixed(2)}h`;
}

/** Convert a line number to a CSS percentage position within the viewport. */
export function linePct(lineNum: number, maxLine: number, vpS: number, vpSpan: number): string {
  return `${((lineNum / maxLine - vpS) / vpSpan * 100).toFixed(4)}%`;
}

export function niceLineStep(raw: number): number {
  const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  for (const s of steps) if (s >= raw) return s;
  return steps[steps.length - 1];
}

export function doZoom([s, e]: Viewport, xFrac: number, zoomIn: boolean): Viewport {
  const span = e - s;
  const factor = zoomIn ? 0.6 : 1 / 0.6;
  const newSpan = clamp(span * factor, 0.0005, 1);
  const center = s + xFrac * span;
  let ns = center - xFrac * newSpan;
  let ne = ns + newSpan;
  if (ns < 0) { ns = 0; ne = newSpan; }
  if (ne > 1) { ne = 1; ns = 1 - newSpan; }
  return [ns, ne];
}

export function doPan([s, e]: Viewport, deltaNorm: number): Viewport {
  const span = e - s;
  const ns = clamp(s + deltaNorm, 0, 1 - span);
  return [ns, ns + span];
}

export const LABEL_W = 130;
