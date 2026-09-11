/** @jsxImportSource solid-js */
import { describe, expect, it } from 'vitest';
import { render } from '@solidjs/testing-library';
import type { HighlightSpan } from '@bridge/generated/HighlightSpan';
import { HighlightedText, segments } from './HighlightedText';

const span = (start: number, end: number, kind: HighlightSpan['kind']): HighlightSpan =>
  ({ start, end, kind });

const search = { type: 'Search' } as const;
const pii = { type: 'PiiReplaced' } as const;

describe('segments()', () => {
  it('returns the whole text as one unhighlighted segment when there are no highlights', () => {
    expect(segments('hello world', [])).toEqual([{ text: 'hello world', start: 0, kinds: [] }]);
  });

  it('splits at highlight boundaries', () => {
    const segs = segments('abcdef', [span(2, 4, search)]);
    expect(segs.map((s) => s.text)).toEqual(['ab', 'cd', 'ef']);
    expect(segs.map((s) => s.kinds.length)).toEqual([0, 1, 0]);
    expect(segs.map((s) => s.start)).toEqual([0, 2, 4]);
  });

  it('stacks kinds on the overlapping region only', () => {
    // "abcdefgh": Search over 1..5, Pii over 3..7 → overlap is 3..5.
    const segs = segments('abcdefgh', [span(1, 5, search), span(3, 7, pii)]);
    expect(segs.map((s) => s.text)).toEqual(['a', 'bc', 'de', 'fg', 'h']);
    expect(segs.map((s) => s.kinds.map((k) => k.type))).toEqual([
      [],
      ['Search'],
      ['Search', 'PiiReplaced'],
      ['PiiReplaced'],
      [],
    ]);
  });

  it('keeps adjacent highlights as separate segments', () => {
    const segs = segments('abcdef', [span(0, 3, search), span(3, 6, pii)]);
    expect(segs.map((s) => s.text)).toEqual(['abc', 'def']);
    expect(segs.map((s) => s.kinds.map((k) => k.type))).toEqual([['Search'], ['PiiReplaced']]);
  });

  it('clamps out-of-range spans to the text', () => {
    const segs = segments('abc', [span(-5, 99, search)]);
    expect(segs.map((s) => s.text)).toEqual(['abc']);
    expect(segs[0].kinds.map((k) => k.type)).toEqual(['Search']);
  });
});

describe('<HighlightedText>', () => {
  it('emits plain spans when nothing is highlighted', () => {
    const { container } = render(() => <HighlightedText text="plain line" highlights={[]} />);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(container.textContent).toBe('plain line');
  });

  it('emits a <mark> per highlighted segment and spans elsewhere', () => {
    const { container } = render(() => (
      <HighlightedText text="abcdef" highlights={[span(2, 4, search)]} />
    ));
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('cd');
    expect(container.textContent).toBe('abcdef');
  });

  it('marks each of two adjacent highlights separately', () => {
    const { container } = render(() => (
      <HighlightedText text="abcdef" highlights={[span(0, 3, search), span(3, 6, pii)]} />
    ));
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
    expect([...marks].map((m) => m.textContent)).toEqual(['abc', 'def']);
    // Different kinds ⇒ different classes.
    expect(marks[0].className).not.toBe(marks[1].className);
  });

  it('gives an overlapping segment both highlight classes', () => {
    const { container } = render(() => (
      <HighlightedText text="abcdefgh" highlights={[span(1, 5, search), span(3, 7, pii)]} />
    ));
    const marks = container.querySelectorAll('mark');
    expect([...marks].map((m) => m.textContent)).toEqual(['bc', 'de', 'fg']);
    expect(marks[1].className.split(' ').filter(Boolean)).toHaveLength(2);
    expect(container.textContent).toBe('abcdefgh');
  });
});
