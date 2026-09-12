/** @jsxImportSource solid-js */
/**
 * Permanent XSS regression suite — the probe table from E1's review of the
 * (now replaced) hand-rolled sanitizer/serializer, re-run against the real
 * `rehype-sanitize` + `rehype-stringify` pipeline and this module's tightened
 * schema (`sanitizeSchema.ts`).
 *
 * Every probe is asserted at the DOM level, not by string-matching the HTML:
 * the output is parsed into a detached element and walked for a dangerous tag,
 * a live `on*` handler, a `style` attribute, or an `href`/`src` whose scheme is
 * `javascript:`/`data:`/`vbscript:`. String-matching the serialized HTML would
 * be brittle against (and blind to) escaping differences between serializers —
 * see the `<` vs `&#x3C;` note in `Markdown.test.tsx`.
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './renderMarkdown';
import { LINE_REF_CLASS } from './lineRefs';
import type { LineRefSource } from './lineRefs';

/** Tags that must never appear in sanitized output, however they got there. */
const DANGEROUS_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'meta', 'link',
  'base', 'applet', 'template',
]);

const DANGEROUS_URL = /^\s*(javascript|data|vbscript):/i;

/**
 * Parse `html` and fail with every offence found, rather than the first —
 * a probe that trips two rules should say so.
 */
function assertNoXss(html: string): void {
  const container = document.createElement('div');
  container.innerHTML = html;
  const offences: string[] = [];

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode() as Element | null;
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (DANGEROUS_TAGS.has(tag)) offences.push(`dangerous element <${tag}>`);
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) offences.push(`event handler ${name} on <${tag}>`);
      if (name === 'style') offences.push(`style attribute on <${tag}>`);
      if ((name === 'href' || name === 'src') && DANGEROUS_URL.test(attr.value)) {
        offences.push(`dangerous ${name} on <${tag}>: ${attr.value}`);
      }
    }
    node = walker.nextNode() as Element | null;
  }

  expect(offences).toEqual([]);
}

interface Probe {
  id: string;
  markdown: string;
  /** Extra assertions beyond "nothing dangerous survived" — e.g. text kept. */
  check?: (html: string) => void;
}

const PROBES: Probe[] = [
  // (a) Raw HTML in the markdown source — remark-rehype's allowDangerousHtml
  // stays off, so none of this ever becomes hast; rehype-sanitize is the belt
  // to that parser-level brace, and both layers are exercised together here.
  { id: 'a-script', markdown: '<script>alert(1)</script>' },
  { id: 'a-script-inline', markdown: 'hi <script>alert(1)</script> bye' },
  { id: 'a-img-onerror', markdown: 'text <img src=x onerror="alert(1)"> more' },
  { id: 'a-svg-onload', markdown: '<svg onload=alert(1)></svg>' },
  { id: 'a-svg-nested', markdown: '<svg><script>alert(1)</script></svg>' },
  { id: 'a-iframe', markdown: '<iframe src="javascript:alert(1)"></iframe>' },
  { id: 'a-iframe-srcdoc', markdown: '<iframe srcdoc="<script>alert(1)</script>"></iframe>' },
  { id: 'a-a-js', markdown: '<a href="javascript:alert(1)">x</a>' },
  { id: 'a-a-datahtml', markdown: '<a href="data:text/html;base64,YWxlcnQoMSk=">x</a>' },
  { id: 'a-form', markdown: '<form action="//evil.test"><input><button>go</button></form>' },
  { id: 'a-style', markdown: '<style>body{background:url(javascript:alert(1))}</style>' },
  { id: 'a-meta', markdown: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">' },
  { id: 'a-object', markdown: '<object data="javascript:alert(1)"></object>' },
  { id: 'a-body-onload', markdown: '<body onload="alert(1)">' },
  { id: 'a-details-ontoggle', markdown: '<details ontoggle="alert(1)">x</details>' },
  { id: 'a-noscript', markdown: '<noscript><img src=x onerror=alert(1)></noscript>' },
  { id: 'a-template', markdown: '<template><script>alert(1)</script></template>' },
  { id: 'e-html-comment', markdown: '<!-- <script>alert(1)</script> -->' },
  { id: 'e-cdata', markdown: '<![CDATA[<script>alert(1)</script>]]>' },

  // (c) Attribute/serializer breakout attempts via ordinary markdown syntax —
  // no sanitizer stripping is at play here, only escaping correctness.
  {
    id: 'c-alt-breakout',
    markdown: '![" onerror="alert(1)](x.png)',
    check: (html) => expect(html).not.toMatch(/onerror\s*=\s*["']?alert/i),
  },
  {
    id: 'c-lang-breakout',
    markdown: '```js" onload="alert(1)\ncode\n```',
    check: (html) => expect(html).not.toMatch(/onload\s*=\s*["']?alert/i),
  },
  {
    id: 'c-url-rawquote',
    markdown: '[x](<https://a.test/" onmouseover="alert(1)>)',
    check: (html) => expect(html).not.toMatch(/onmouseover\s*=\s*["']?alert/i),
  },
  { id: 'c-code-breakout', markdown: '`" onmouseover="alert(1)`' },
  { id: 'c-fence-breakout', markdown: '```\n" onmouseover="alert(1)\n```' },
  { id: 'c-heading-breakout', markdown: '# </h1><script>alert(1)</script>' },
  { id: 'c-table-breakout', markdown: '| a |\n| --- |\n| </td><script>alert(1)</script> |' },
  {
    id: 'c-text-amp-lt-gt',
    markdown: 'a & b < c > d " e',
    // `&` and `<` are always escaped (as numeric entities) so the DOM parses
    // this back to a single text run, never a new element — `assertNoXss`'s
    // DOM walk is what actually proves that; this just confirms escaping ran.
    check: (html) => {
      expect(html).toContain('&#x26;');
      expect(html).toContain('&#x3C;');
    },
  },

  // (d) GFM autolinks and every obfuscation of a `javascript:` (or similar)
  // link target that still parses as a link in CommonMark/GFM.
  {
    id: 'd-gfm-autolink',
    markdown: 'See http://evil.test/a?b=1 for details.',
    check: (html) => expect(html).toContain('href="http://evil.test/a?b=1"'),
  },
  {
    id: 'd-gfm-autolink-mail',
    markdown: 'Contact a@b.test.',
    check: (html) => expect(html).toContain('href="mailto:a@b.test"'),
  },
  { id: 'd-md-link-js', markdown: '[click](javascript:alert(1))', check: (html) => expect(html).toContain('click') },
  { id: 'd-md-link-js-upper', markdown: '[click](JaVaScRiPt:alert(1))', check: (html) => expect(html).toContain('click') },
  { id: 'd-md-link-js-ctrl', markdown: '[click](java\u0000script:alert(1))', check: (html) => expect(html).toContain('click') },
  { id: 'd-md-link-js-space', markdown: '[click]( javascript:alert(1))', check: (html) => expect(html).toContain('click') },
  { id: 'd-md-link-entity', markdown: '[click](&#106;avascript:alert(1))', check: (html) => expect(html).toContain('click') },
  { id: 'd-md-link-vbscript', markdown: '[click](vbscript:alert(1))', check: (html) => expect(html).toContain('click') },
  { id: 'd-md-link-data', markdown: '[click](data:text/html,<script>alert(1)</script>)', check: (html) => expect(html).toContain('click') },
  {
    id: 'd-md-ref-link-js',
    markdown: '[click][x]\n\n[x]: javascript:alert(1)',
    check: (html) => expect(html).toContain('click'),
  },
  { id: 'd-md-img-js', markdown: '![alt](javascript:alert(1))' },
  { id: 'd-md-img-data-html', markdown: '![alt](data:text/html;base64,YWxlcnQoMSk=)' },
  { id: 'd-md-autolink-js', markdown: '<javascript:alert(1)>' },

  // (e) GFM footnotes — remark-gfm prefixes ids with `user-content-` itself
  // (its `clobberPrefix`), and `rehype-sanitize`'s own DOM-clobbering defence
  // prefixes `id` again on top (it has no way to know one is already applied)
  // — cosmetically doubled, but the point of both is the same: no footnote id
  // reaches the DOM unprefixed, where it could clobber a global `window.<id>`.
  {
    id: 'e-footnote',
    markdown: 'See it[^1].\n\n[^1]: the note',
    check: (html) => {
      expect(html).toContain('id="user-content-user-content-fn-1"');
      expect(html).not.toMatch(/\bid="fn-1"/);
      expect(html).not.toMatch(/\bid="user-content-fn-1"/);
    },
  },
];

describe('Markdown XSS regression (permanent probe table)', () => {
  it.each(PROBES)('neutralises probe: $id', ({ markdown, check }) => {
    const html = renderMarkdown(markdown);
    assertNoXss(html);
    check?.(html);
  });

  it('benign GFM still renders after sanitization', () => {
    const html = renderMarkdown(
      [
        '| a | b |',
        '| --- | --: |',
        '| 1 | 2 |',
        '',
        '~~gone~~',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '```ts',
        'const x: number = 1;',
        '```',
        '',
        '[safe](https://example.com/a)',
      ].join('\n'),
    );
    assertNoXss(html);
    expect(html).toContain('<table>');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('href="https://example.com/a"');
  });

  it('keeps data-session/data-line/data-end-line on a line-ref anchor through sanitization', () => {
    const reference: LineRefSource = {
      lineNumber: 100,
      endLine: 120,
      label: 'Stall',
      highlightType: 'Anchor',
      sessionId: 'sess-9',
      resolved: true,
    };
    const html = renderMarkdown('The stall runs L100-120 in the trace.', { references: [reference] });
    assertNoXss(html);

    const container = document.createElement('div');
    container.innerHTML = html;
    const anchor = container.querySelector(`a.${LINE_REF_CLASS}`);
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute('data-session')).toBe('sess-9');
    expect(anchor?.getAttribute('data-line')).toBe('100');
    expect(anchor?.getAttribute('data-end-line')).toBe('120');
    expect(anchor?.getAttribute('data-anchor')).toBe('true');
    expect(anchor?.textContent).toBe('L100–120');
  });

  it('does not let an attacker forge data-line/data-session via raw HTML', () => {
    // Raw HTML never becomes hast (allowDangerousHtml: false), but if the
    // schema ever changed to allow it, dataLine/dataSession must still only be
    // reachable through the lineRefs pass, never author-supplied markup.
    const html = renderMarkdown(
      '<a class="lt-line-ref" data-session="forged" data-line="1" href="javascript:alert(1)">forged</a>',
    );
    assertNoXss(html);
    const container = document.createElement('div');
    container.innerHTML = html;
    const anchor = container.querySelector(`a.${LINE_REF_CLASS}`);
    expect(anchor).toBeNull();
  });
});
