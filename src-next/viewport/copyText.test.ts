import { describe, it, expect } from 'vitest';
import { buildCopyText } from './copyText';
import type { Selection } from './SelectionManager';

function makeLineSelection(lines: number[]): Selection {
  return { anchor: lines[0] ?? null, selected: new Set(lines), mode: 'line' };
}

function makeBoxSelection(
  startLine: number, endLine: number, startCol: number, endCol: number,
): Selection {
  return {
    anchor: startLine,
    selected: new Set(),
    mode: 'box',
    box: { startLine, endLine, startCol, endCol },
  };
}

describe('buildCopyText', () => {
  // ---------- Line mode ----------

  it('copies a single line', () => {
    const getText = (n: number) => n === 5 ? 'hello world' : undefined;
    const result = buildCopyText(makeLineSelection([5]), getText);
    expect(result).toBe('hello world');
  });

  it('copies multiple lines in order', () => {
    const lines: Record<number, string> = { 0: 'first', 1: 'second', 2: 'third' };
    const getText = (n: number) => lines[n];
    const result = buildCopyText(makeLineSelection([2, 0, 1]), getText);
    expect(result).toBe('first\nsecond\nthird');
  });

  it('preserves empty lines in selection', () => {
    const lines: Record<number, string> = {
      0: '========',
      1: 'header',
      2: '========',
      3: '',           // empty line
      4: 'Build: ...',
    };
    const getText = (n: number) => lines[n];
    const result = buildCopyText(makeLineSelection([0, 1, 2, 3, 4]), getText);
    expect(result).toBe('========\nheader\n========\n\nBuild: ...');
  });

  it('preserves multiple consecutive empty lines', () => {
    const lines: Record<number, string> = { 0: 'a', 1: '', 2: '', 3: 'b' };
    const getText = (n: number) => lines[n];
    const result = buildCopyText(makeLineSelection([0, 1, 2, 3]), getText);
    expect(result).toBe('a\n\n\nb');
  });

  it('skips uncached (undefined) lines but keeps empty string lines', () => {
    const lines: Record<number, string> = { 0: 'cached', 1: '', 3: 'also cached' };
    // line 2 is not in cache → returns undefined
    const getText = (n: number) => lines[n];
    const result = buildCopyText(makeLineSelection([0, 1, 2, 3]), getText);
    expect(result).toBe('cached\n\nalso cached');
  });

  it('returns null for empty selection', () => {
    const result = buildCopyText(makeLineSelection([]), () => 'anything');
    expect(result).toBeNull();
  });

  // ---------- Box mode ----------

  it('copies box selection with column range', () => {
    const lines: Record<number, string> = {
      0: 'ABCDEFGH',
      1: '12345678',
      2: 'xyzwvuts',
    };
    const getText = (n: number) => lines[n];
    const result = buildCopyText(makeBoxSelection(0, 2, 2, 5), getText);
    expect(result).toBe('CDE\n345\nzwv');
  });

  it('box selection preserves empty lines as empty slices', () => {
    const lines: Record<number, string> = {
      0: 'ABCDEFGH',
      1: '',           // empty line → slice(2, 5) = ''
      2: 'xyzwvuts',
    };
    const getText = (n: number) => lines[n];
    const result = buildCopyText(makeBoxSelection(0, 2, 2, 5), getText);
    expect(result).toBe('CDE\n\nzwv');
  });

  it('box selection treats uncached lines as empty', () => {
    const lines: Record<number, string> = { 0: 'ABCDEFGH', 2: 'xyzwvuts' };
    // line 1 is undefined → fallback to '' → slice produces ''
    const getText = (n: number) => lines[n];
    const result = buildCopyText(makeBoxSelection(0, 2, 2, 5), getText);
    expect(result).toBe('CDE\n\nzwv');
  });
});
