// @vitest-environment jsdom
/**
 * Classifier + delegated-handler coverage for `externalLinks.ts`.
 *
 * A relative or protocol-relative href (or a disallowed scheme) reaching the
 * chrome-less webview's default anchor navigation is unrecoverable — see the
 * module header. This file is the ground-truth table for what each href shape
 * classifies as; the three renderers (`src-solid/editor/Markdown.tsx`,
 * `components/AnalysisReader/MarkdownSection.tsx`,
 * `components/EditorTab/MarkdownPreview.tsx`) each carry one smaller test that
 * exercises the same behaviour through their own click handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyLinkHref,
  externalLinkHrefFrom,
  isExternalLinkHref,
  openExternalLinkFromEvent,
} from './externalLinks';

const openExternalUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock('./commands', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}));

afterEach(() => {
  openExternalUrl.mockClear();
  vi.restoreAllMocks();
});

describe('classifyLinkHref', () => {
  it('classifies allow-listed absolute schemes as external', () => {
    expect(classifyLinkHref('http://example.com')).toBe('external');
    expect(classifyLinkHref('https://example.com/a?b=1')).toBe('external');
    expect(classifyLinkHref('mailto:a@example.com')).toBe('external');
  });

  it('is case-insensitive on the scheme', () => {
    expect(classifyLinkHref('HTTP://example.com')).toBe('external');
    expect(classifyLinkHref('Https://example.com')).toBe('external');
    expect(classifyLinkHref('MAILTO:a@example.com')).toBe('external');
  });

  it('classifies a fragment-only href separately from a blocked one', () => {
    expect(classifyLinkHref('#heading')).toBe('fragment');
    expect(classifyLinkHref('#')).toBe('fragment');
  });

  it('blocks every path-relative form', () => {
    expect(classifyLinkHref('./notes.md')).toBe('blocked');
    expect(classifyLinkHref('notes.md')).toBe('blocked');
    expect(classifyLinkHref('/notes.md')).toBe('blocked');
    expect(classifyLinkHref('../notes.md')).toBe('blocked');
    expect(classifyLinkHref('?q=1')).toBe('blocked');
  });

  it('blocks a protocol-relative href', () => {
    expect(classifyLinkHref('//example.com/a')).toBe('blocked');
  });

  it('blocks a non-allow-listed scheme', () => {
    expect(classifyLinkHref('javascript:alert(1)')).toBe('blocked');
    expect(classifyLinkHref('file:///etc/passwd')).toBe('blocked');
    expect(classifyLinkHref('data:text/html,<script>1</script>')).toBe('blocked');
  });

  it('returns null for no href at all', () => {
    expect(classifyLinkHref(null)).toBeNull();
    expect(classifyLinkHref(undefined)).toBeNull();
    expect(classifyLinkHref('')).toBeNull();
  });
});

describe('isExternalLinkHref', () => {
  it('agrees with classifyLinkHref', () => {
    expect(isExternalLinkHref('https://example.com')).toBe(true);
    expect(isExternalLinkHref('./notes.md')).toBe(false);
    expect(isExternalLinkHref('#heading')).toBe(false);
    expect(isExternalLinkHref(null)).toBe(false);
  });
});

/** Build a minimal click-like event whose target is an anchor with `href`. */
function clickOn(href: string | null): { target: HTMLAnchorElement; preventDefault: () => void; prevented: boolean } {
  const anchor = document.createElement('a');
  if (href !== null) anchor.setAttribute('href', href);
  document.body.appendChild(anchor);
  const state = { prevented: false };
  return {
    target: anchor,
    preventDefault: () => {
      state.prevented = true;
    },
    get prevented() {
      return state.prevented;
    },
  };
}

describe('externalLinkHrefFrom', () => {
  it('returns the href only for an external anchor', () => {
    expect(externalLinkHrefFrom(clickOn('https://example.com').target)).toBe('https://example.com');
    expect(externalLinkHrefFrom(clickOn('./notes.md').target)).toBeNull();
    expect(externalLinkHrefFrom(clickOn('#heading').target)).toBeNull();
    expect(externalLinkHrefFrom(clickOn(null).target)).toBeNull();
  });
});

describe('openExternalLinkFromEvent', () => {
  it('cancels and opens an external link', () => {
    const event = clickOn('https://example.com/a');
    expect(openExternalLinkFromEvent(event)).toBe(true);
    expect(event.prevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/a');
  });

  it('cancels a path-relative link without opening anything', () => {
    const event = clickOn('./notes.md');
    expect(openExternalLinkFromEvent(event)).toBe(true);
    expect(event.prevented).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('cancels a protocol-relative link without opening anything', () => {
    const event = clickOn('//evil.example.com');
    expect(openExternalLinkFromEvent(event)).toBe(true);
    expect(event.prevented).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('cancels a disallowed scheme without opening anything', () => {
    const event = clickOn('file:///etc/passwd');
    expect(openExternalLinkFromEvent(event)).toBe(true);
    expect(event.prevented).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('leaves a fragment-only href to the browser default action', () => {
    const event = clickOn('#heading');
    expect(openExternalLinkFromEvent(event)).toBe(false);
    expect(event.prevented).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('leaves an anchor with no href at all to the caller (e.g. a line-ref anchor)', () => {
    const event = clickOn(null);
    expect(openExternalLinkFromEvent(event)).toBe(false);
    expect(event.prevented).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('is a no-op for a click outside any anchor', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    let prevented = false;
    const event = { target: div, preventDefault: () => { prevented = true; } };
    expect(openExternalLinkFromEvent(event)).toBe(false);
    expect(prevented).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
