// @vitest-environment jsdom
/**
 * An external link in a published analysis must not navigate the webview.
 *
 * The section body is markdown the app does not author — `publish_analysis`
 * over the MCP bridge lets an agent write it. A plain `[docs](https://…)`
 * anchor used to get the browser default: the whole chrome-less window was
 * replaced by the remote page, with no back affordance and no recovery short of
 * killing the process. The section body now delegates the click to
 * `bridge/externalLinks`, which cancels it and hands the URL to the OS.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MarkdownSection from './MarkdownSection';
import type { ResolvedSection } from './MarkdownSection';

const openExternalUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock('../../bridge/commands', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}));

afterEach(() => {
  cleanup();
  openExternalUrl.mockClear();
});

function sectionWith(body: string): ResolvedSection {
  return { heading: 'Findings', body, severity: null, references: [] } as unknown as ResolvedSection;
}

/** The anchor's own click, with `defaultPrevented` observable afterwards. */
function clickLink(text: string): boolean {
  const anchor = screen.getByText(text);
  return !fireEvent.click(anchor);
}

describe('MarkdownSection — external links', () => {
  it('opens an https link in the OS handler instead of navigating', () => {
    render(<MarkdownSection section={sectionWith('See [docs](https://example.com/a?b=1).')} onJump={vi.fn()} />);

    expect(clickLink('docs')).toBe(true); // default prevented → no navigation
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/a?b=1');
  });

  it('opens a mailto link the same way', () => {
    render(<MarkdownSection section={sectionWith('Mail [us](mailto:a@example.com).')} onJump={vi.fn()} />);

    expect(clickLink('us')).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith('mailto:a@example.com');
  });

  it('leaves a click on ordinary prose alone', () => {
    render(<MarkdownSection section={sectionWith('Just **text**, no link.')} onJump={vi.fn()} />);

    fireEvent.click(screen.getByText('text'));
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('does not open a relative or fragment-only href', () => {
    render(
      <MarkdownSection
        section={sectionWith('[rel](./notes.md) and [frag](#heading)')}
        onJump={vi.fn()}
      />,
    );

    clickLink('rel');
    clickLink('frag');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('never opens a javascript: href — react-markdown strips it first', () => {
    render(<MarkdownSection section={sectionWith('[x](javascript:alert(1))')} onJump={vi.fn()} />);

    clickLink('x');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
