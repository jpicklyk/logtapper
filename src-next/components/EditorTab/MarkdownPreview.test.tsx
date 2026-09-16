// @vitest-environment jsdom
/**
 * Same guarantee as `AnalysisReader/MarkdownSection.test.tsx`, for the other
 * react-markdown renderer: a link in a previewed `.md` document opens in the OS
 * default handler and never navigates the webview off the app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownPreview } from './MarkdownPreview';

const openExternalUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock('../../bridge/commands', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
}));

afterEach(() => {
  cleanup();
  openExternalUrl.mockClear();
});

describe('MarkdownPreview — external links', () => {
  it('opens an http link in the OS handler and cancels the navigation', () => {
    render(<MarkdownPreview content="Read the [spec](http://example.com/spec)." />);

    const prevented = !fireEvent.click(screen.getByText('spec'));
    expect(prevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith('http://example.com/spec');
  });

  it('ignores clicks that are not on an external anchor', () => {
    render(<MarkdownPreview content={'# Heading\n\nplain paragraph'} />);

    fireEvent.click(screen.getByText('plain paragraph'));
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('blocks a relative href but leaves a fragment href to the browser', () => {
    render(<MarkdownPreview content="[rel](./notes.md) and [frag](#heading)" />);

    // A relative href would otherwise navigate the chrome-less webview with no
    // way back — it must be default-prevented even though there is nothing to
    // hand to the OS. A fragment href is a same-page scroll and must NOT be
    // prevented, or in-document navigation breaks.
    const relPrevented = !fireEvent.click(screen.getByText('rel'));
    const fragPrevented = !fireEvent.click(screen.getByText('frag'));

    expect(relPrevented).toBe(true);
    expect(fragPrevented).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('still renders the empty state without a handler crash', () => {
    const { container } = render(<MarkdownPreview content="" />);

    fireEvent.click(container.firstChild as HTMLElement);
    expect(screen.getByText('Nothing to preview')).toBeTruthy();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
