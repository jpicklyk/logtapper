import { describe, it, expect } from 'vitest';
import {
  filterSections,
  extractGroupPrefix,
  applyPrefixGrouping,
  buildSectionTree,
} from './sectionTree';
import type { SectionEntry } from './sectionTree';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSection(name: string, startLine: number, endLine: number, parentIndex?: number): SectionEntry {
  return { name, startLine, endLine, parentIndex };
}

// ── filterSections ────────────────────────────────────────────────────────────

describe('filterSections', () => {
  const sections: SectionEntry[] = [
    makeSection('DUMPSYS', 0, 100),             // 0 — top-level parent
    makeSection('SurfaceFlinger', 1, 20, 0),    // 1 — child of 0
    makeSection('ActivityManager', 21, 40, 0),  // 2 — child of 0
    makeSection('SHOW MAP 1234: foo', 101, 200), // 3 — top-level
    makeSection('SHOW MAP 5678: bar', 201, 300), // 4 — top-level
    makeSection('KERNEL LOG', 301, 400),         // 5 — top-level, no children
  ];

  it('empty query returns all sections unchanged', () => {
    expect(filterSections(sections, '')).toEqual(sections);
  });

  it('query matching a child section promotes its parent', () => {
    const result = filterSections(sections, 'SurfaceFlinger');
    // Should include DUMPSYS (parent promoted) and SurfaceFlinger (matched child)
    expect(result.map(s => s.name)).toContain('DUMPSYS');
    expect(result.map(s => s.name)).toContain('SurfaceFlinger');
    // Should NOT include the unmatched sibling child
    expect(result.map(s => s.name)).not.toContain('ActivityManager');
  });

  it('direct parent match includes all its children', () => {
    const result = filterSections(sections, 'DUMPSYS');
    expect(result.map(s => s.name)).toContain('DUMPSYS');
    expect(result.map(s => s.name)).toContain('SurfaceFlinger');
    expect(result.map(s => s.name)).toContain('ActivityManager');
  });

  it('non-matching query returns empty array', () => {
    expect(filterSections(sections, 'NOTHING_MATCHES_XYZ')).toEqual([]);
  });

  it('case-insensitive matching', () => {
    const result = filterSections(sections, 'surfaceflinger');
    expect(result.map(s => s.name)).toContain('SurfaceFlinger');
  });
});

// ── extractGroupPrefix ────────────────────────────────────────────────────────

describe('extractGroupPrefix', () => {
  it('"SHOW MAP 1690: foo" returns "SHOW MAP "', () => {
    expect(extractGroupPrefix('SHOW MAP 1690: foo')).toBe('SHOW MAP ');
  });

  it('"DUMPSYS" (single word, no trailing content) returns null', () => {
    expect(extractGroupPrefix('DUMPSYS')).toBeNull();
  });

  it('"lowercase name" returns null', () => {
    expect(extractGroupPrefix('lowercase name')).toBeNull();
  });

  it('"ROUTE TABLE IPv4" returns "ROUTE TABLE "', () => {
    expect(extractGroupPrefix('ROUTE TABLE IPv4')).toBe('ROUTE TABLE ');
  });
});

// ── applyPrefixGrouping ───────────────────────────────────────────────────────

describe('applyPrefixGrouping', () => {
  function makeItem(name: string, idx: number): { section: SectionEntry; index: number } {
    return { section: makeSection(name, idx * 10, idx * 10 + 9), index: idx };
  }

  it('run of 5+ shared-prefix items becomes a prefixGroup row', () => {
    const items = [
      makeItem('SHOW MAP 1: a', 0),
      makeItem('SHOW MAP 2: b', 1),
      makeItem('SHOW MAP 3: c', 2),
      makeItem('SHOW MAP 4: d', 3),
      makeItem('SHOW MAP 5: e', 4),
    ];
    const rows = applyPrefixGrouping(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('prefixGroup');
    if (rows[0].kind === 'prefixGroup') {
      expect(rows[0].sections).toHaveLength(5);
      expect(rows[0].prefix).toBe('SHOW MAP ');
    }
  });

  it('run of 4 stays as individual single rows', () => {
    const items = [
      makeItem('SHOW MAP 1: a', 0),
      makeItem('SHOW MAP 2: b', 1),
      makeItem('SHOW MAP 3: c', 2),
      makeItem('SHOW MAP 4: d', 3),
    ];
    const rows = applyPrefixGrouping(items);
    expect(rows).toHaveLength(4);
    expect(rows.every(r => r.kind === 'single')).toBe(true);
  });

  it('mixed runs group correctly', () => {
    const items = [
      makeItem('SHOW MAP 1: a', 0),
      makeItem('SHOW MAP 2: b', 1),
      makeItem('SHOW MAP 3: c', 2),
      makeItem('SHOW MAP 4: d', 3),
      makeItem('SHOW MAP 5: e', 4),
      makeItem('OTHER SECTION', 5),
    ];
    const rows = applyPrefixGrouping(items);
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('prefixGroup');
    expect(rows[1].kind).toBe('single');
  });
});

// ── buildSectionTree ──────────────────────────────────────────────────────────

describe('buildSectionTree', () => {
  it('flat sections with enough shared prefix produce groups', () => {
    const sections: SectionEntry[] = [
      makeSection('SHOW MAP 1: a', 0, 9),
      makeSection('SHOW MAP 2: b', 10, 19),
      makeSection('SHOW MAP 3: c', 20, 29),
      makeSection('SHOW MAP 4: d', 30, 39),
      makeSection('SHOW MAP 5: e', 40, 49),
    ];
    const rows = buildSectionTree(sections, sections);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('prefixGroup');
  });

  it('sections with parentIndex produce parent rows with children', () => {
    const original: SectionEntry[] = [
      makeSection('DUMPSYS', 0, 100),
      makeSection('ActivityManager', 1, 20, 0),
      makeSection('SurfaceFlinger', 21, 40, 0),
    ];
    const rows = buildSectionTree(original, original);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('parent');
    if (rows[0].kind === 'parent') {
      expect(rows[0].section.name).toBe('DUMPSYS');
      expect(rows[0].children).toHaveLength(2);
    }
  });

  it('empty array returns empty', () => {
    expect(buildSectionTree([], [])).toEqual([]);
  });
});
