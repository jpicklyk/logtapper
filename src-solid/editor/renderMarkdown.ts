/**
 * Markdown → sanitized HTML string.
 *
 *   unified()
 *     .use(remarkParse)      // markdown → mdast
 *     .use(remarkGfm)        // tables, strikethrough, task lists, autolinks
 *     .use(remarkRehype)     // mdast → hast; allowDangerousHtml stays off, so
 *                            //   raw HTML in the source never becomes markup
 *     .use(rehypeLineRefs)   // SourceReference mentions → <a data-session data-line>
 *     .use(rehypeSanitize)   // allowlist — see sanitizeSchema.ts
 *     .use(rehypeStringify)  // hast → HTML string
 *
 * All six packages are direct dependencies pinned at exact (`remark-parse`,
 * `remark-rehype`, `unified`) or caret (`remark-gfm`) versions already resolved
 * in the lockfile, plus `rehype-sanitize` / `rehype-stringify` added by this
 * change (see `sanitizeSchema.ts`'s header for why the schema needs tightening
 * beyond `defaultSchema`).
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { rehypeLineRefs } from './lineRefs';
import type { LineRefSource } from './lineRefs';
import { DEFAULT_SCHEMA } from './sanitizeSchema';
import type { SanitizeSchema } from './sanitizeSchema';

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
