import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './renderMarkdown';
import {
  LINE_REF_CLASS,
  lineRefAnchor,
  lineRefText,
  lineRefTitle,
  lineRefTargetFrom,
} from './lineRefs';
import type { LineRefSource } from './lineRefs';

const SINGLE: LineRefSource = {
  lineNumber: 482,
  endLine: null,
  label: 'ANR in system_server',
  highlightType: 'Anchor',
  sessionId: 'sess-1',
  resolved: true,
};

const RANGE: LineRefSource = {
  lineNumber: 900,
  endLine: 912,
  label: 'binder transaction',
  highlightType: 'Annotation',
  sessionId: 'sess-1',
  resolved: true,
};

describe('lineRefText / lineRefTitle', () => {
  it('reproduces LineReference.tsx text exactly', () => {
    // `L{n}` and `L{n}–{m}` with an EN DASH (U+2013), as in LineReference.tsx.
    expect(lineRefText(SINGLE)).toBe('L482');
    expect(lineRefText(RANGE)).toBe('L900–912');
  });

  it('swaps the label for the unresolved explanation', () => {
    expect(lineRefTitle(SINGLE)).toBe('ANR in system_server');
    expect(lineRefTitle({ ...SINGLE, resolved: false })).toMatch(/not open/i);
  });
});

describe('lineRefAnchor', () => {
  it('carries the session, line and range on data attributes', () => {
    const anchor = lineRefAnchor(RANGE, LINE_REF_CLASS);
    expect(anchor.tagName).toBe('a');
    expect(anchor.properties).toMatchObject({
      dataSession: 'sess-1',
      dataLine: '900',
      dataEndLine: '912',
      role: 'link',
      tabIndex: 0,
    });
    expect(anchor.properties.dataAnchor).toBeUndefined();
  });

  it('omits dataSession for an unattributed reference and flags Anchor/unresolved', () => {
    const anchor = lineRefAnchor(
      { lineNumber: 5, sessionId: null, highlightType: 'Anchor', resolved: false },
      LINE_REF_CLASS,
    );
    expect(anchor.properties.dataSession).toBeUndefined();
    expect(anchor.properties.dataAnchor).toBe('true');
    expect(anchor.properties.dataUnresolved).toBe('true');
  });
});

describe('rehypeLineRefs through the pipeline', () => {
  it('anchors a mention that matches a reference', () => {
    const html = renderMarkdown('See L482 for the stall.', { references: [SINGLE] });
    expect(html).toContain(`<a class="${LINE_REF_CLASS}"`);
    expect(html).toContain('data-session="sess-1"');
    expect(html).toContain('data-line="482"');
    expect(html).toContain('>L482</a>');
    // Surrounding prose survives intact.
    expect(html).toContain('See <a');
    expect(html).toContain('for the stall.');
  });

  it('accepts a hyphen range in the source but emits the EN DASH form', () => {
    const html = renderMarkdown('Range L900-912 here.', { references: [RANGE] });
    expect(html).toContain('data-end-line="912"');
    expect(html).toContain('>L900–912</a>');
  });

  it('leaves a mention with no matching reference as plain text', () => {
    const html = renderMarkdown('Unknown L777 mention.', { references: [SINGLE] });
    expect(html).not.toContain('lt-line-ref');
    expect(html).toContain('Unknown L777 mention.');
  });

  it('does not rewrite inside a code fence or inline code', () => {
    const html = renderMarkdown('```\nassert L482\n```\n\nand `L482` too.', {
      references: [SINGLE],
    });
    expect(html).toContain('<pre><code>assert L482');
    expect(html).toContain('<code>L482</code>');
    expect(html).not.toContain('lt-line-ref');
  });

  it('is a no-op when no references are supplied', () => {
    expect(renderMarkdown('L482')).toContain('<p>L482</p>');
  });
});

describe('lineRefTargetFrom', () => {
  function anchorEl(attributes: Record<string, string>): HTMLElement {
    const host = document.createElement('div');
    const anchor = document.createElement('a');
    anchor.className = LINE_REF_CLASS;
    for (const [key, value] of Object.entries(attributes)) anchor.setAttribute(key, value);
    anchor.textContent = 'L482';
    host.append(anchor);
    return anchor;
  }

  it('reads the target off the anchor', () => {
    const anchor = anchorEl({ 'data-session': 'sess-1', 'data-line': '482' });
    expect(lineRefTargetFrom(anchor)).toEqual({ sessionId: 'sess-1', line: 482, endLine: null });
  });

  it('resolves a click on a node inside the anchor', () => {
    const anchor = anchorEl({ 'data-session': 's', 'data-line': '7', 'data-end-line': '9' });
    const inner = document.createElement('span');
    anchor.append(inner);
    expect(lineRefTargetFrom(inner)).toEqual({ sessionId: 's', line: 7, endLine: 9 });
  });

  it('returns null off-anchor, for a non-element, and for an unresolved anchor', () => {
    expect(lineRefTargetFrom(document.createElement('p'))).toBeNull();
    expect(lineRefTargetFrom(null)).toBeNull();
    expect(
      lineRefTargetFrom(anchorEl({ 'data-line': '1', 'data-unresolved': 'true' })),
    ).toBeNull();
  });
});
