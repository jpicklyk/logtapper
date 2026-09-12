/** @jsxImportSource solid-js */
import { createMemo } from 'solid-js';
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

  const handleClick = (event: MouseEvent) => {
    const target = lineRefTargetFrom(event.target);
    if (!target) return;
    event.preventDefault();
    props.onLineRef?.(target);
  };

  // Space/Enter on a focused anchor is the keyboard equivalent of the click.
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
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
