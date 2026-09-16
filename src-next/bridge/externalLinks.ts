/**
 * External links inside rendered markdown.
 *
 * Analysis and editor prose can contain `[docs](https://example.com)` — and an
 * MCP agent can publish such an analysis through the bridge, so the link text is
 * not necessarily something the person at the keyboard wrote. Letting the
 * webview follow it is unrecoverable: the window has no browser chrome, so the
 * remote page replaces the entire UI with no way back. The backend refuses the
 * navigation outright (`src-tauri/src/webview_guard.rs`); this module is the
 * frontend half that makes the link still *do* something useful, by handing it
 * to the OS default handler instead.
 *
 * Framework-free on purpose — `MarkdownSection`/`MarkdownPreview` (React) and
 * `editor/Markdown.tsx` (Solid) all render their markdown into a container and
 * delegate one click handler on it, so they share every line below.
 */

import { openExternalUrl } from './commands';

/**
 * The only schemes handed to the OS.
 *
 * Mirrors the scope on `opener:allow-open-url` in
 * `src-tauri/capabilities/default.json` — keep the two in step. Anything else
 * (`file:`, a custom scheme, a relative or fragment-only href) is left alone
 * here and separately refused by the backend scope check, so a mismatch fails
 * closed.
 */
export const EXTERNAL_LINK_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:'];

/** `scheme:` of an absolute URL, lowercased. `null` for a relative href. */
function schemeOf(href: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  return match === null ? null : `${match[1].toLowerCase()}:`;
}

/** Whether `href` is one this module will open externally. */
export function isExternalLinkHref(href: string | null | undefined): href is string {
  if (!href) return false;
  const scheme = schemeOf(href);
  return scheme !== null && EXTERNAL_LINK_SCHEMES.includes(scheme);
}

/**
 * The external href of the anchor `target` sits in, or `null`.
 *
 * Reads the `href` *attribute* rather than the `.href` property: the property
 * resolves relative hrefs against the app origin, which would turn `./notes` —
 * a link this module deliberately does not open — into an absolute `http://…`
 * that it does.
 */
export function externalLinkHrefFrom(target: EventTarget | null): string | null {
  if (!(target instanceof globalThis.Element)) return null;
  const anchor = target.closest('a');
  if (anchor === null) return null;
  const href = anchor.getAttribute('href');
  return isExternalLinkHref(href) ? href : null;
}

/**
 * Open `href` in the OS default handler. Never throws: a rejected `invoke` (no
 * Tauri host, a scope refusal, no registered handler for the scheme) is a
 * console warning, because the caller is a click handler with nowhere to report.
 */
export function openExternalLink(href: string): void {
  if (!isExternalLinkHref(href)) return;
  void openExternalUrl(href).catch((error: unknown) => {
    console.warn('[externalLinks] could not open external link', { href, error });
  });
}

/**
 * The minimum an event needs for {@link openExternalLinkFromEvent}. React's
 * `SyntheticEvent` and the DOM's `Event` both satisfy it structurally, so one
 * handler serves both frontends.
 */
export interface InterceptableEvent {
  readonly target: EventTarget | null;
  preventDefault(): void;
}

/**
 * Delegated handler: if the event landed inside an external anchor, cancel the
 * navigation and open the URL externally instead.
 *
 * Returns whether it handled the event, so a container that also has its own
 * anchor semantics (the Solid renderer's line references) can tell the two
 * apart. Safe to attach to a container that has no links at all.
 */
export function openExternalLinkFromEvent(event: InterceptableEvent): boolean {
  const href = externalLinkHrefFrom(event.target);
  if (href === null) return false;
  event.preventDefault();
  openExternalLink(href);
  return true;
}
