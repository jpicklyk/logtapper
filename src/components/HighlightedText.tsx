import type { HighlightSpan } from '../bridge/types';

interface Props {
  text: string;
  highlights: HighlightSpan[];
}

interface Segment {
  text: string;
  start: number;
  kinds: HighlightSpan['kind'][];
}

/**
 * Splits text into non-overlapping segments at highlight boundaries,
 * then renders each segment with the appropriate CSS classes stacked.
 */
export default function HighlightedText({ text, highlights }: Props) {
  if (highlights.length === 0) {
    return <span>{text}</span>;
  }

  // Collect all boundary points
  const boundaries = new Set<number>([0, text.length]);
  for (const h of highlights) {
    boundaries.add(Math.max(0, h.start));
    boundaries.add(Math.min(text.length, h.end));
  }
  const sorted = Array.from(boundaries).sort((a, b) => a - b);

  // Build segments
  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const segText = text.slice(start, end);
    const kinds = highlights
      .filter((h) => h.start <= start && h.end >= end)
      .map((h) => h.kind);
    segments.push({ text: segText, start, kinds });
  }

  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.kinds.length === 0) {
          return <span key={idx}>{seg.text}</span>;
        }

        const classNames: string[] = [];
        for (const kind of seg.kinds) {
          switch (kind.type) {
            case 'Search':
              classNames.push('hl-search');
              break;
            case 'SearchActive':
              classNames.push('hl-search-active');
              break;
            case 'ProcessorMatch':
              classNames.push('hl-processor');
              break;
            case 'ExtractedField':
              classNames.push('hl-field');
              break;
            case 'PiiReplaced':
              classNames.push('hl-pii');
              break;
          }
        }

        return (
          <mark key={idx} className={classNames.join(' ')}>
            {seg.text}
          </mark>
        );
      })}
    </>
  );
}
