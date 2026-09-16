/** @jsxImportSource solid-js */
import { createMemo } from 'solid-js';
import { openExternalLinkFromEvent } from '@bridge/externalLinks';
import { renderMarkdown } from './renderMarkdown';
import { lineRefTargetFrom } from './lineRefs';
import type { LineRefSource, LineRefTarget } from './lineRefs';
import styles from './editor.module.css';

export interface MarkdownProps {
  content: string;
  /** Mentions of these references become `<a data-session data-line>` anchors. */
  references?: readonly LineRefSource[];
  /** Fired when a generated anchor (or anything inside one) is clicked. */
  onLineRef?: (target: LineRefTarget) => void;
  class?: string;
  /** Shown instead of the prose when `content` is empty. */
  emptyText?: string;
  /**
   * Handles an `http`/`https`/`mailto` anchor in the prose. Defaults to
   * `openExternalLinkFromEvent` (OS default handler via `tauri-plugin-opener`);
   * overridable so a test can assert the interception without a Tauri host.
   * Returns whether it consumed the event.
   */
  interceptExternalLink?: (event: MouseEvent | KeyboardEvent) => boolean;
}

/**
 * Sanitized markdown.
 *
 * The HTML is produced once per `content`/`references` change by a memo and set
 * with `innerHTML` — the string has already been through the allowlist in
 * `sanitize.ts`, and `remark-rehype` dropped raw HTML before that. Anchor clicks
 * are handled by one delegated listener on the container rather than per-anchor
 * handlers, because the anchors are plain markup, not components.
 */
export function Markdown(props: MarkdownProps) {
  const html = createMemo(() =>
    renderMarkdown(props.content, { references: props.references }),
  );

  // An `http`/`https`/`mailto` anchor that survived sanitisation would otherwise
  // navigate the whole webview away from the app (see `@bridge/externalLinks`),
  // so it is intercepted before the line-reference check — the two anchor kinds
  // are disjoint (a line-ref anchor carries no `href` at all), the order just
  // keeps the expensive-to-recover case first.
  const interceptExternal = (event: MouseEvent | KeyboardEvent): boolean =>
    (props.interceptExternalLink ?? openExternalLinkFromEvent)(event);

  const handleClick = (event: MouseEvent) => {
    if (interceptExternal(event)) return;
    const target = lineRefTargetFrom(event.target);
    if (!target) return;
    event.preventDefault();
    props.onLineRef?.(target);
  };

  // Space/Enter on a focused anchor is the keyboard equivalent of the click.
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // External anchors are real links, and a real link activates on Enter only
    // (Space scrolls). Cancelling the Enter here also cancels the synthetic
    // click the browser would otherwise dispatch, so the URL opens once.
    if (event.key === 'Enter' && interceptExternal(event)) return;
    const target = lineRefTargetFrom(event.target);
    if (!target) return;
    event.preventDefault();
    props.onLineRef?.(target);
  };

  return (
    <div
      class={props.class ? `${styles.prose} ${props.class}` : styles.prose}
      data-testid="markdown"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {props.content
        ? // eslint-disable-next-line solid/no-innerhtml
          <div innerHTML={html()} />
        : <div class={styles.empty}>{props.emptyText ?? 'Nothing to preview'}</div>}
    </div>
  );
}
