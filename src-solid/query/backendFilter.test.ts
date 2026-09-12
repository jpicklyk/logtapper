import { describe, expect, it } from 'vitest';
import { parseFilter } from '@filter/index';
import { buildBackendFilter, EMPTY_CRITERIA } from './backendFilter';
import type { BackendFilter } from './backendFilter';

function extract(expr: string): BackendFilter | null {
  const ast = parseFilter(expr);
  return ast ? buildBackendFilter(ast) : null;
}

describe('buildBackendFilter', () => {
  it('emits every FilterCriteria field, so the wire shape is always complete', () => {
    const result = extract('level:E');
    expect(result).not.toBeNull();
    expect(Object.keys(result!.criteria).sort()).toEqual(Object.keys(EMPTY_CRITERIA).sort());
  });

  describe('table', () => {
    const rows: Array<{
      name: string;
      expr: string;
      expected: Partial<typeof EMPTY_CRITERIA> | null;
      needsJsPass?: boolean;
    }> = [
      {
        name: 'level exact — backend answer needs no JS pass',
        expr: 'level:E',
        expected: { logLevels: ['Error'], combine: 'and' },
        needsJsPass: false,
      },
      {
        name: 'level + tag — a compound AND, still exact',
        expr: 'level:W tag:Activity',
        expected: { logLevels: ['Warn'], tags: ['Activity'], combine: 'and' },
        needsJsPass: false,
      },
      {
        name: 'level + free text — superset, JS confirms tag/message semantics',
        expr: 'level:E boom',
        expected: { logLevels: ['Error'], textSearch: 'boom', combine: 'and' },
        needsJsPass: true,
      },
      {
        name: 'message: — raw-line textSearch superset',
        expr: 'message:crash',
        expected: { textSearch: 'crash', combine: 'and' },
        needsJsPass: true,
      },
      {
        name: 'homogeneous OR — union of one field type, combine flips to or',
        expr: 'level:E | level:F',
        expected: { logLevels: ['Error', 'Fatal'], combine: 'or' },
        needsJsPass: false,
      },
      {
        // A heterogeneous OR is only a problem when it must be folded into an
        // AND parent (see below). Standing alone it maps cleanly, because
        // combine:'or' is exactly the semantics the backend applies.
        name: 'heterogeneous OR at the top level — combine:or carries the semantics',
        expr: 'level:E | tag:Activity',
        expected: { logLevels: ['Error'], tags: ['Activity'], combine: 'or' },
        needsJsPass: false,
      },
      {
        name: 'pid exact',
        expr: 'pid:1234',
        expected: { pids: [1234], combine: 'and' },
        needsJsPass: false,
      },
      {
        name: 'longer textSearch wins the merge (fewer backend false positives)',
        expr: 'ab abcdef',
        expected: { textSearch: 'abcdef', combine: 'and' },
        needsJsPass: true,
      },
      // ── Rejections: the backend cannot produce a superset at all ──────────
      { name: 'top-level NOT', expr: '!level:E', expected: null },
      { name: 'bare tid: — no FilterCriteria equivalent', expr: 'tid:77', expected: null },
      { name: 'package: — resolves to pids only at scan time', expr: 'package:com.example', expected: null },
      { name: 'unparseable level value', expr: 'level:Q', expected: null },
      { name: 'non-numeric pid', expr: 'pid:abc', expected: null },
      { name: 'OR with one unexpressible branch — partial OR extraction is unsafe', expr: 'level:E | tid:7', expected: null },
      { name: 'AND of two unexpressible atoms', expr: 'tid:1 !level:E', expected: null },
      { name: 'empty expression never reaches the extractor', expr: '   ', expected: null },
    ];

    for (const row of rows) {
      it(row.name, () => {
        const result = extract(row.expr);
        if (row.expected === null) {
          expect(result).toBeNull();
          return;
        }
        expect(result).not.toBeNull();
        expect(result!.criteria).toEqual({ ...EMPTY_CRITERIA, ...row.expected });
        expect(result!.needsJsPass).toBe(row.needsJsPass);
      });
    }
  });

  it('heterogeneous OR inside an AND is skipped, not merged — needsJsPass instead', () => {
    // Merging `level:E | tag:Activity` into the AND criteria would silently
    // convert it to AND semantics and drop real matches (false negatives).
    const result = extract('pid:99 (level:E | tag:Activity)');
    expect(result).not.toBeNull();
    expect(result!.needsJsPass).toBe(true);
    expect(result!.criteria).toEqual({ ...EMPTY_CRITERIA, pids: [99] });
    // The OR's own fields must NOT have leaked into the AND criteria.
    expect(result!.criteria.logLevels).toBeNull();
    expect(result!.criteria.tags).toBeNull();
  });

  it('AND with one unexpressible child keeps the expressible part and flags a JS pass', () => {
    const result = extract('level:E tid:7');
    expect(result).toEqual({
      criteria: { ...EMPTY_CRITERIA, logLevels: ['Error'] },
      needsJsPass: true,
    });
  });

  it('a homogeneous OR nested in an AND merges without flipping the AND to or', () => {
    const result = extract('tag:Foo (level:E | level:W)');
    expect(result).not.toBeNull();
    // The nested OR carries one field type only, so merging it is safe; the
    // parent then sees two field types and settles on AND.
    expect(result!.criteria.combine).toBe('and');
    expect(result!.criteria.tags).toEqual(['Foo']);
    expect(result!.criteria.logLevels).toEqual(['Error', 'Warn']);
    expect(result!.needsJsPass).toBe(false);
  });

  it('never populates regex — a text atom becomes textSearch, not a regex pattern', () => {
    // The React original has no `regex:` field mapping; the flag exists on the
    // wire but only the search path (W2b) ever sets it. Pinned so a future
    // "just map it" change has to be deliberate.
    const result = extract('"a.*b"');
    expect(result!.criteria.regex).toBeNull();
    expect(result!.criteria.textSearch).toBe('a.*b');
  });

  it('never populates the ns time range — time filtering is not part of the extractor', () => {
    // `timeStart`/`timeEnd` are ns-since-2000 on the wire and are filled in by
    // the search path from the query bar's time inputs, never derived from a
    // filter expression. An unknown `time:` field is simply unexpressible.
    expect(extract('time:12:00:00')).toBeNull();
    const withLevel = extract('level:E time:12:00:00');
    expect(withLevel!.criteria.timeStart).toBeNull();
    expect(withLevel!.criteria.timeEnd).toBeNull();
    expect(withLevel!.needsJsPass).toBe(true);
  });
});
