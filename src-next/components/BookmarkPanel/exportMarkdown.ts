import type { Bookmark } from '../../bridge/types';

export interface ExportContext {
  sourceName?: string;
  totalLines?: number;
}

export function exportBookmarksAsMarkdown(
  bookmarks: Bookmark[],
  context: ExportContext,
): string {
  const sorted = [...bookmarks].sort((a, b) => a.lineNumber - b.lineNumber);
  const lines: string[] = [];

  lines.push('# Bookmark Timeline');
  lines.push('');
  if (context.sourceName) lines.push(`**Source:** ${context.sourceName}`);
  lines.push(`**Bookmarks:** ${sorted.length}`);
  lines.push(`**Exported:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const b of sorted) {
    const cat = b.category ?? 'custom';
    const lineRef = b.lineNumberEnd != null
      ? `L${b.lineNumber + 1}-${b.lineNumberEnd + 1}`
      : `L${b.lineNumber + 1}`;

    lines.push(`## [${cat}] ${b.label} (${lineRef})`);
    lines.push('');

    if (b.note) {
      lines.push(b.note);
      lines.push('');
    }

    if (b.snippet && b.snippet.length > 0) {
      lines.push('```');
      for (const s of b.snippet) lines.push(s);
      lines.push('```');
      lines.push('');
    }

    if (b.tags && b.tags.length > 0) {
      lines.push(`**Tags:** ${b.tags.join(', ')}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
