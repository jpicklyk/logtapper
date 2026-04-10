export interface SectionEntry {
  name: string;
  startLine: number;
  endLine: number;
  parentIndex?: number;
}

/** A single section, a collapsible prefix group, or a parent+children DUMPSYS block. */
export type SectionRow =
  | { kind: 'single'; section: SectionEntry; index: number }
  | { kind: 'prefixGroup'; prefix: string; sections: { section: SectionEntry; index: number }[];
      totalLines: number }
  | { kind: 'parent'; section: SectionEntry; index: number;
      children: { section: SectionEntry; index: number }[]; totalLines: number };

export const GROUP_THRESHOLD = 5;

/**
 * Extract a groupable prefix from a section name. Returns the prefix string
 * (including trailing space) if the name looks like "PREFIX detail...", e.g.
 * "SHOW MAP 1690: ..." → "SHOW MAP ", "ROUTE TABLE IPv4" → "ROUTE TABLE ".
 * Returns null if no groupable prefix is found.
 */
export function extractGroupPrefix(name: string): string | null {
  const m = name.match(/^([A-Z][A-Z0-9_]+(?: [A-Z][A-Z0-9_]+)*) /);
  if (!m) return null;
  return m[1] + ' ';
}

/**
 * Filter sections by a search query. Case-insensitive. When a child matches,
 * its parent is promoted. When a parent directly matches, all its children
 * are included.
 */
export function filterSections(sections: SectionEntry[], query: string): SectionEntry[] {
  if (!query) return sections;
  const q = query.toLowerCase();
  const matchIndices = new Set<number>();
  // Track which parents matched the query directly (not just via child promotion)
  const directParentMatches = new Set<number>();

  // Direct name matches — include parent of any matching child
  sections.forEach((s, i) => {
    if (s.name.toLowerCase().includes(q)) {
      matchIndices.add(i);
      if (s.parentIndex === undefined) {
        // This is a top-level section that directly matched
        directParentMatches.add(i);
      } else {
        // Child matched — promote its parent (but don't mark as direct match)
        matchIndices.add(s.parentIndex);
      }
    }
  });

  // Only include ALL children when the parent itself directly matched the query.
  // When a parent was only included because a child matched, keep only matching children.
  sections.forEach((s, i) => {
    if (s.parentIndex !== undefined && directParentMatches.has(s.parentIndex)) {
      matchIndices.add(i);
    }
  });

  return sections.filter((_, i) => matchIndices.has(i));
}

/**
 * Apply prefix grouping to a flat list of indexed sections.
 * Runs of GROUP_THRESHOLD+ consecutive sections sharing a prefix become a prefixGroup.
 */
export function applyPrefixGrouping(
  items: { section: SectionEntry; index: number }[],
): SectionRow[] {
  const rows: SectionRow[] = [];
  let i = 0;
  while (i < items.length) {
    const prefix = extractGroupPrefix(items[i].section.name);
    if (prefix) {
      let j = i + 1;
      while (j < items.length && items[j].section.name.startsWith(prefix)) j++;
      const runLen = j - i;
      if (runLen >= GROUP_THRESHOLD) {
        const groupItems = items.slice(i, j);
        let lines = 0;
        for (const item of groupItems) lines += item.section.endLine - item.section.startLine + 1;
        rows.push({
          kind: 'prefixGroup',
          prefix,
          sections: groupItems,
          totalLines: lines,
        });
        i = j;
        continue;
      }
    }
    rows.push({ kind: 'single', section: items[i].section, index: items[i].index });
    i++;
  }
  return rows;
}

/**
 * Build a tree of SectionRows from a flat (possibly filtered) sections array.
 *
 * Sections with parentIndex become children of their parent. Top-level sections
 * without children are subject to prefix grouping. Top-level sections that have
 * children become parent rows.
 *
 * `originalSections` is needed because `parentIndex` values reference positions
 * in the unfiltered backend array — when sections are filtered, array positions
 * shift but parentIndex values don't. We resolve parent identity via startLine.
 */
export function buildSectionTree(sections: SectionEntry[], originalSections: SectionEntry[]): SectionRow[] {
  if (sections.length === 0) return [];

  // 1. Build parent-startLine → children map.
  // parentIndex references the *original* array, so resolve to startLine for stable matching.
  const childrenByParentStartLine = new Map<number, { section: SectionEntry; index: number }[]>();
  sections.forEach((s, i) => {
    if (s.parentIndex !== undefined && s.parentIndex < originalSections.length) {
      const parentStartLine = originalSections[s.parentIndex].startLine;
      let arr = childrenByParentStartLine.get(parentStartLine);
      if (!arr) { arr = []; childrenByParentStartLine.set(parentStartLine, arr); }
      arr.push({ section: s, index: i });
    }
  });

  // 2. Walk top-level sections (no parentIndex)
  const rows: SectionRow[] = [];
  // Accumulate consecutive childless top-level sections for prefix grouping
  let pendingChildless: { section: SectionEntry; index: number }[] = [];

  const flushPending = () => {
    if (pendingChildless.length === 0) return;
    const grouped = applyPrefixGrouping(pendingChildless);
    rows.push(...grouped);
    pendingChildless = [];
  };

  sections.forEach((s, i) => {
    if (s.parentIndex !== undefined) return; // skip children — handled via parent

    const children = childrenByParentStartLine.get(s.startLine);
    if (children && children.length > 0) {
      // Flush any pending childless sections first to preserve order
      flushPending();
      let totalLines = s.endLine - s.startLine + 1;
      for (const c of children) totalLines += c.section.endLine - c.section.startLine + 1;
      rows.push({ kind: 'parent', section: s, index: i, children, totalLines });
    } else {
      pendingChildless.push({ section: s, index: i });
    }
  });

  flushPending();
  return rows;
}
