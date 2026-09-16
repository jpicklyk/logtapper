/** @jsxImportSource solid-js */
import { For, createMemo } from 'solid-js';
import type { HighlightKind } from '@bridge/generated/HighlightKind';
import type { HighlightSpan } from '@bridge/generated/HighlightSpan';
import styles from './LogViewer.module.css';

/**
 * Solid port of the React `components/HighlightedText/HighlightedText.tsx`.
 *
 * The React version has no framework-free helper to reuse — the boundary/segment
 * maths lives in the component body — so `segments()` below is that logic lifted
 * out verbatim and exported for direct testing.
 *
 * The `.hl-*` classes the React version emits are global (`styles/highlights.css`,
 * which `src-solid` does not load). Here they are module-scoped classes in
 * `LogViewer.module.css` instead, so the Solid app carries its own styling.
 */

export interface Segment {
  text: string;
  /** Offset into the original line text — stable identity for `<For>`. */
  start: number;
  kinds: HighlightKind[];
}

/**
 * Split `text` at every highlight boundary. A segment carries every highlight
 * kind that fully covers it, so overlapping spans stack their classes and
 * adjacent spans produce separate segments.
 */
export function segments(text: string, highlights: HighlightSpan[]): Segment[] {
  if (highlights.length === 0) {
    return [{ text, start: 0, kinds: [] }];
  }

  const boundaries = new Set<number>([0, text.length]);
  for (const h of highlights) {
    boundaries.add(Math.max(0, h.start));
    boundaries.add(Math.min(text.length, h.end));
  }
  const sorted = Array.from(boundaries).sort((a, b) => a - b);

  const out: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    out.push({
      text: text.slice(start, end),
      start,
      kinds: highlights.filter((h) => h.start <= start && h.end >= end).map((h) => h.kind),
    });
  }
  return out;
}

/**
 * Merge controller-supplied spans over the ones the backend put on the line.
 *
 * Controller spans win: any backend span that overlaps one is dropped rather
 * than stacked, so a search hit re-kinded by the controller renders with the
 * controller's kind alone. Non-overlapping backend spans survive. The result is
 * ascending by `start`, which is what `segments` walks.
 */
export function mergeHighlights(
  base: readonly HighlightSpan[],
  override: readonly HighlightSpan[],
): HighlightSpan[] {
  if (override.length === 0) return base.slice();
  const kept = base.filter((b) => !override.some((o) => o.start < b.end && b.start < o.end));
  return [...kept, ...override].sort((a, b) => a.start - b.start || a.end - b.end);
}

const KIND_CLASS: Record<HighlightKind['type'], string> = {
  Search: styles.hlSearch,
  SearchActive: styles.hlSearchActive,
  ProcessorMatch: styles.hlProcessor,
  ExtractedField: styles.hlField,
  PiiReplaced: styles.hlPii,
};

/** Class list for a segment, in highlight order. Empty ⇒ render a plain span. */
export function segmentClass(seg: Segment): string {
  return seg.kinds.map((k) => KIND_CLASS[k.type]).filter(Boolean).join(' ');
}

export function HighlightedText(props: { text: string; highlights: HighlightSpan[] }) {
  const segs = createMemo(() => segments(props.text, props.highlights));

  return (
    <For each={segs()}>
      {(seg) => {
        const cls = segmentClass(seg);
        return cls ? <mark class={cls}>{seg.text}</mark> : <span>{seg.text}</span>;
      }}
    </For>
  );
}
