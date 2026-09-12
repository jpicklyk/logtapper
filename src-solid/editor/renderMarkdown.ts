/**
 * Markdown → sanitized HTML string.
 *
 * The pipeline plan §G asked for, with two substitutions forced by the lockfile
 * (see `sanitize.ts` / `toHtml.ts` headers):
 *
 *   unified()
 *     .use(remarkParse)      // markdown → mdast
 *     .use(remarkGfm)        // tables, strikethrough, task lists, autolinks
 *     .use(remarkRehype)     // mdast → hast; allowDangerousHtml stays off, so
 *                            //   raw HTML in the source never becomes markup
 *     .use(rehypeLineRefs)   // SourceReference mentions → <a data-session data-line>
 *     .use(rehypeSanitize)   // local stand-in for rehype-sanitize
 *     .use(rehypeStringify)  // local stand-in for rehype-stringify
 *
 * `remark-parse`, `remark-gfm`, `remark-rehype` and `unified` are pinned as
 * direct dependencies at the versions already resolved in `package-lock.json`.
 * `rehype-sanitize` and `rehype-stringify` are **not in the lockfile at all** —
 * react-markdown v10 renders straight to JSX and brings in neither — so they are
 * implemented in this directory rather than installed.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { rehypeLineRefs } from './lineRefs';
import type { LineRefSource } from './lineRefs';
import { rehypeSanitize, DEFAULT_SCHEMA } from './sanitize';
import type { SanitizeSchema } from './sanitize';
import { rehypeStringify } from './toHtml';

export interface RenderMarkdownOptions {
  /** References whose `L<n>` / `L<n>–<m>` mentions become clickable anchors. */
  references?: readonly LineRefSource[];
  /** Override the allowlist. Defaults to `DEFAULT_SCHEMA`. */
  schema?: SanitizeSchema;
}

/**
 * Render `content` to sanitized HTML.
 *
 * Synchronous on purpose: every plugin in the chain is synchronous, so
 * `processSync` never throws the "async plugin" error, and the caller can put
 * this straight in a memo without a loading state.
 */
export function renderMarkdown(content: string, options: RenderMarkdownOptions = {}): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeLineRefs, { references: options.references ?? [] })
    .use(rehypeSanitize, options.schema ?? DEFAULT_SCHEMA)
    .use(rehypeStringify);

  return String(processor.processSync(content));
}
