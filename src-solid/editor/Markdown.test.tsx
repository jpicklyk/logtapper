/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { Markdown } from './Markdown';
import { AnalysisSectionView } from './AnalysisSectionView';
import type { ResolvedSection } from './AnalysisSectionView';
import { renderMarkdown } from './renderMarkdown';
import type { LineRefSource } from './lineRefs';

// The one bridge call this component makes. Stubbed so the default (un-injected)
// external-link path runs end to end without a Tauri host.
const openExternalUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock('@bridge/commands', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}));

// vitest `globals` is off, so @solidjs/testing-library's auto-cleanup never registers.
afterEach(() => {
  cleanup();
  openExternalUrl.mockClear();
});

const REFERENCE: LineRefSource = {
  lineNumber: 482,
  endLine: null,
  label: 'ANR',
  highlightType: 'Anchor',
  sessionId: 'sess-1',
  resolved: true,
};

describe('renderMarkdown — GFM', () => {
  it('renders a table', () => {
    const html = renderMarkdown('| a | b |\n| --- | --: |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('>1</td>');
  });

  it('renders strikethrough and task lists', () => {
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>');
    const tasks = renderMarkdown('- [x] done\n- [ ] todo');
    expect(tasks).toContain('<input type="checkbox"');
    expect(tasks).toContain('checked');
    expect(tasks).toContain('disabled');
  });

  it('renders a fenced code block with its language class', () => {
    const html = renderMarkdown('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('const x: number = 1;');
  });

  it('escapes markup characters inside code rather than emitting tags', () => {
    const html = renderMarkdown('```\n<b>hi</b>\n```');
    // `<` is always escaped (as the numeric entity `&#x3C;`); a bare `>` in
    // text content needs no escaping to stay unambiguous and is left as-is.
    // Either way, no real `<b>` element is produced.
    expect(html).not.toContain('<b>hi</b>');
    expect(html).toContain('&#x3C;b>hi&#x3C;/b>');
  });
});

describe('renderMarkdown — sanitization', () => {
  it('drops raw HTML from the source', () => {
    const html = renderMarkdown('before\n\n<script>alert(1)</script>\n\n<div>raw</div>\n\nafter');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('<div');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('drops an inline <img onerror> and its handler', () => {
    const html = renderMarkdown('text <img src=x onerror="alert(1)"> more');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
  });

  it('strips a javascript: link target but keeps the link text', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click');
  });

  it('keeps http(s) and relative link targets', () => {
    expect(renderMarkdown('[x](https://example.com/a)')).toContain('href="https://example.com/a"');
    expect(renderMarkdown('[x](./notes.md)')).toContain('href="./notes.md"');
  });
});

describe('Markdown component', () => {
  it('shows the empty state when there is no content', () => {
    const { getByText } = render(() => <Markdown content="" />);
    expect(getByText('Nothing to preview')).toBeTruthy();
  });

  it('generates line-ref anchors with the right data attributes', () => {
    const { container } = render(() => (
      <Markdown content="See L482 now." references={[REFERENCE]} />
    ));
    const anchor = container.querySelector('a.lt-line-ref');
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute('data-session')).toBe('sess-1');
    expect(anchor?.getAttribute('data-line')).toBe('482');
    expect(anchor?.getAttribute('data-anchor')).toBe('true');
    expect(anchor?.textContent).toBe('L482');
  });

  it('delegates a click on the anchor to onLineRef', () => {
    const onLineRef = vi.fn();
    const { container } = render(() => (
      <Markdown content="See L482 now." references={[REFERENCE]} onLineRef={onLineRef} />
    ));
    fireEvent.click(container.querySelector('a.lt-line-ref')!);
    expect(onLineRef).toHaveBeenCalledWith({ sessionId: 'sess-1', line: 482, endLine: null });
  });

  it('ignores clicks that are not on a generated anchor', () => {
    const onLineRef = vi.fn();
    const { container } = render(() => (
      <Markdown content="plain prose" references={[REFERENCE]} onLineRef={onLineRef} />
    ));
    fireEvent.click(container.querySelector('p')!);
    expect(onLineRef).not.toHaveBeenCalled();
  });

  it('activates an anchor from the keyboard', () => {
    const onLineRef = vi.fn();
    const { container } = render(() => (
      <Markdown content="See L482." references={[REFERENCE]} onLineRef={onLineRef} />
    ));
    fireEvent.keyDown(container.querySelector('a.lt-line-ref')!, { key: 'Enter' });
    expect(onLineRef).toHaveBeenCalledTimes(1);
  });

  it('opens an external link in the OS handler instead of navigating', () => {
    // Without this the chrome-less webview follows the link and the whole UI is
    // replaced by the remote page, unrecoverably.
    const { container } = render(() => (
      <Markdown content="See [docs](https://example.com/a?b=1) now." />
    ));
    const anchor = container.querySelector<HTMLAnchorElement>('a[href^="https://"]')!;
    const dispatched = fireEvent.click(anchor);

    expect(dispatched).toBe(false); // preventDefault() ran
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/a?b=1');
  });

  it('opens a mailto link the same way', () => {
    const { container } = render(() => <Markdown content="[mail](mailto:a@example.com)" />);
    fireEvent.click(container.querySelector('a[href^="mailto:"]')!);
    expect(openExternalUrl).toHaveBeenCalledWith('mailto:a@example.com');
  });

  it('activates an external link from the keyboard (Enter, not Space)', () => {
    const { container } = render(() => <Markdown content="[docs](https://example.com/)" />);
    const anchor = container.querySelector('a[href^="https://"]')!;

    fireEvent.keyDown(anchor, { key: ' ' });
    expect(openExternalUrl).not.toHaveBeenCalled();

    fireEvent.keyDown(anchor, { key: 'Enter' });
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/');
  });

  it('leaves relative hrefs and a stripped javascript: link alone', () => {
    const { container } = render(() => (
      <Markdown content="[rel](./notes.md) [frag](#h) [js](javascript:alert(1))" />
    ));
    for (const anchor of container.querySelectorAll('a')) fireEvent.click(anchor);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('blocks a relative href but leaves a fragment href to the browser', () => {
    // A relative href would otherwise navigate the chrome-less webview with no
    // way back — it must be default-prevented even though there is nothing to
    // hand to the OS. A fragment href is a same-page scroll and must NOT be
    // prevented, or in-document navigation breaks.
    const { container } = render(() => (
      <Markdown content="[rel](./notes.md) [frag](#h)" />
    ));
    const [relAnchor, fragAnchor] = container.querySelectorAll('a');

    const relDispatched = fireEvent.click(relAnchor);
    const fragDispatched = fireEvent.click(fragAnchor);

    expect(relDispatched).toBe(false); // preventDefault() ran
    expect(fragDispatched).toBe(true); // left to the browser
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('keeps the line-reference path untouched by the external-link check', () => {
    const onLineRef = vi.fn();
    const { container } = render(() => (
      <Markdown content="See L482 now." references={[REFERENCE]} onLineRef={onLineRef} />
    ));
    fireEvent.click(container.querySelector('a.lt-line-ref')!);

    expect(onLineRef).toHaveBeenCalledWith({ sessionId: 'sess-1', line: 482, endLine: null });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('lets a caller override the interception', () => {
    const intercept = vi.fn(() => true);
    const { container } = render(() => (
      <Markdown content="[docs](https://example.com/)" interceptExternalLink={intercept} />
    ));
    fireEvent.click(container.querySelector('a[href^="https://"]')!);

    expect(intercept).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('re-renders when the content changes', () => {
    const [content, setContent] = createSignal('# one');
    const { container } = render(() => <Markdown content={content()} />);
    expect(container.querySelector('h1')?.textContent).toBe('one');
    setContent('## two');
    expect(container.querySelector('h2')?.textContent).toBe('two');
  });
});

describe('AnalysisSectionView', () => {
  const SECTION: ResolvedSection = {
    heading: 'Main thread stall',
    body: 'The stall begins at L482 and clears later.',
    severity: 'Error',
    references: [
      {
        lineNumber: 482,
        endLine: null,
        label: 'ANR',
        highlightType: 'Anchor',
        sessionId: 'sess-1',
        resolved: true,
        sourceLabel: 'bugreport.txt',
      },
    ],
  };

  it('renders the heading, severity badge and the reference chip', () => {
    const { container, getByText } = render(() => <AnalysisSectionView section={SECTION} />);
    expect(getByText('Main thread stall')).toBeTruthy();
    expect(getByText('Error')).toBeTruthy();
    expect(getByText('bugreport.txt')).toBeTruthy();
    // severityColor('Error') → var(--danger), handed to CSS as --section-accent.
    const article = container.querySelector<HTMLElement>('[data-testid="analysis-section"]');
    expect(article!.style.getPropertyValue('--section-accent')).toBe('var(--danger)');
  });

  it('jumps from the chip and from a mention in the body', () => {
    const onJump = vi.fn();
    const { container } = render(() => (
      <AnalysisSectionView section={SECTION} onJump={onJump} />
    ));
    fireEvent.click(container.querySelector('button')!);
    fireEvent.click(container.querySelector('a.lt-line-ref')!);
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenLastCalledWith({ sessionId: 'sess-1', line: 482, endLine: null });
  });

  it('disables the chip for a reference whose session is not open', () => {
    const onJump = vi.fn();
    const section: ResolvedSection = {
      ...SECTION,
      references: [{ ...SECTION.references[0], resolved: false, sourceLabel: undefined }],
    };
    const { container } = render(() => <AnalysisSectionView section={section} onJump={onJump} />);
    expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(true);
    // The in-prose anchor is inert too.
    fireEvent.click(container.querySelector('a.lt-line-ref')!);
    expect(onJump).not.toHaveBeenCalled();
  });
});

