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
 * `src-tauri/capabilities/default.json` — keep the two in step. A scheme
 * outside this list (`file:`, `data:`, a custom scheme) is not opened here and
 * is separately refused by the backend scope check, so a mismatch fails
 * closed. A path-relative or protocol-relative href is not a scheme mismatch
 * at all — see {@link classifyLinkHref}, which is what decides whether such a
 * click is blocked instead of left alone.
 */
export const EXTERNAL_LINK_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:'];

/** `scheme:` of an absolute URL, lowercased. `null` for a relative or scheme-less href. */
function schemeOf(href: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  return match === null ? null : `${match[1].toLowerCase()}:`;
}

/**
 * How a click handler should treat an anchor's `href` attribute.
 *
 * - `'external'` — a scheme in {@link EXTERNAL_LINK_SCHEMES}; hand it to the OS.
 * - `'fragment'` — an in-document anchor (`#heading`); leave it to the
 *   browser's own default action so same-page scrolling keeps working.
 * - `'blocked'` — anything else rendered markdown can produce: a
 *   path-relative href (`./x`, `x`, `/x`, `../x`, `?q`), a protocol-relative
 *   `//host`, or a scheme the allow-list doesn't cover (`javascript:`,
 *   `file:`, `data:`, …). The webview has no browser chrome, so letting the
 *   default action run would replace the whole app with no way back — this
 *   must be cancelled even though there is nothing useful to do with it.
 */
export type LinkHrefKind = 'external' | 'fragment' | 'blocked';

/** Classify a raw `href` attribute value. `null`/`undefined`/empty → no href at all. */
export function classifyLinkHref(href: string | null | undefined): LinkHrefKind | null {
  if (!href) return null;
  if (href.startsWith('#')) return 'fragment';
  const scheme = schemeOf(href);
  if (scheme !== null && EXTERNAL_LINK_SCHEMES.includes(scheme)) return 'external';
  return 'blocked';
}

/** Whether `href` is one this module will open externally. */
export function isExternalLinkHref(href: string | null | undefined): href is string {
  return classifyLinkHref(href) === 'external';
}

/** An anchor's `href` attribute plus its classification. */
interface AnchorHrefInfo {
  readonly href: string;
  readonly kind: LinkHrefKind;
}

/**
 * The anchor `target` sits in, classified, or `null` if there is none (or it
 * carries no `href` at all — a generated line-reference anchor, for example).
 *
 * Reads the `href` *attribute* rather than the `.href` property: the property
 * resolves relative hrefs against the app origin, which would turn `./notes`
 * into an absolute `http://…` and hide that it was ever relative.
 */
function anchorHrefInfoFrom(target: EventTarget | null): AnchorHrefInfo | null {
  if (!(target instanceof globalThis.Element)) return null;
  const anchor = target.closest('a');
  if (anchor === null) return null;
  const href = anchor.getAttribute('href');
  const kind = classifyLinkHref(href);
  return kind === null ? null : { href: href as string, kind };
}

/** The external href of the anchor `target` sits in, or `null`. */
export function externalLinkHrefFrom(target: EventTarget | null): string | null {
  const info = anchorHrefInfoFrom(target);
  return info !== null && info.kind === 'external' ? info.href : null;
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
 * Delegated handler: classifies the anchor (if any) the event landed inside.
 *
 * - `external` → cancel the navigation and open the URL externally.
 * - `blocked` (path-relative, protocol-relative, or a disallowed scheme) →
 *   cancel the navigation and do nothing else; a `console.warn` is the only
 *   trace, since the caller is a click handler with nowhere else to report.
 *   Left unhandled, the chrome-less webview would navigate to it directly —
 *   the same unrecoverable failure an external link would cause, just with no
 *   OS handler to hand it to.
 * - `fragment` (`#heading`) or no anchor/no href at all → not handled; the
 *   browser's default action runs, which is what makes same-page scrolling
 *   and the Solid renderer's own line-reference anchors keep working.
 *
 * Returns whether it handled (cancelled) the event, so a container that also
 * has its own anchor semantics (the Solid renderer's line references) can
 * tell the two apart. Safe to attach to a container that has no links at all.
 */
export function openExternalLinkFromEvent(event: InterceptableEvent): boolean {
  const info = anchorHrefInfoFrom(event.target);
  if (info === null || info.kind === 'fragment') return false;
  event.preventDefault();
  if (info.kind === 'external') {
    openExternalLink(info.href);
  } else {
    console.warn('[externalLinks] blocked a relative or unsupported link', { href: info.href });
  }
  return true;
}
