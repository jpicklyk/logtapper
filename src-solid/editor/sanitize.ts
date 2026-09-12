/**
 * hast allowlist sanitizer.
 *
 * A local stand-in for `rehype-sanitize` — see the header of `toHtml.ts` for why
 * the real package could not be used (it is not in `package-lock.json`, and this
 * package may not change the lockfile).
 *
 * Two layers already sit in front of it: `remark-rehype` runs with its default
 * `allowDangerousHtml: false`, so raw HTML in the markdown source never becomes
 * hast at all, and `remark-gfm` applies the GFM tagfilter. This pass is the one
 * that bounds the *attribute* space — notably it is what permits exactly the
 * `data-session` / `data-line` attributes `lineRefs` generates and nothing else.
 */

import type { Element, ElementContent, Root, RootContent } from 'hast';

export interface SanitizeSchema {
  /** Elements kept. An element not listed is unwrapped (its children survive). */
  tagNames: string[];
  /** tagName → allowed hast property names. `'*'` applies to every element. */
  attributes: Record<string, string[]>;
  /** hast property name → URL schemes allowed in its value. */
  protocols: Record<string, string[]>;
}

const URL_SAFE_PROTOCOLS = ['http', 'https', 'mailto', 'tel'];

/**
 * Everything `mdast-util-to-hast` + `remark-gfm` emit, plus the line-reference
 * anchor. Deliberately no `script`, `style`, `iframe`, `object`, `form`, or any
 * event-handler attribute — those are not in the allowlist, so they cannot be
 * added by accident.
 */
export const DEFAULT_SCHEMA: SanitizeSchema = {
  tagNames: [
    'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'img', 'input', 'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'sup',
    'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
  ],
  attributes: {
    '*': ['className', 'id'],
    // `dataSession` / `dataLine` / `dataEndLine` / `dataAnchor` / `dataUnresolved`
    // are what `lineRefs` writes; `role` + `tabIndex` make the href-less anchor
    // focusable and announced as a link.
    a: ['href', 'title', 'role', 'tabIndex', 'dataSession', 'dataLine', 'dataEndLine', 'dataAnchor', 'dataUnresolved'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    // GFM task-list checkboxes.
    input: ['type', 'checked', 'disabled'],
    td: ['align', 'colSpan', 'rowSpan'],
    th: ['align', 'colSpan', 'rowSpan', 'scope'],
    ol: ['start'],
    li: ['value'],
  },
  protocols: {
    href: URL_SAFE_PROTOCOLS,
    src: URL_SAFE_PROTOCOLS,
  },
};

/**
 * `true` when `value` is a same-document/relative URL or uses an allowed scheme.
 * Anything with a scheme we do not recognise (`javascript:`, `data:`, `vbscript:`)
 * is rejected. Control characters are stripped first so `java\nscript:` cannot
 * slip past the scheme test.
 */
function isAllowedUrl(value: string, protocols: string[]): boolean {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0020]/g, '');
  const colon = cleaned.indexOf(':');
  if (colon < 0) return true;
  const slash = cleaned.indexOf('/');
  const question = cleaned.indexOf('?');
  const hash = cleaned.indexOf('#');
  // A colon that appears after a `/`, `?` or `#` is part of a path, not a scheme.
  for (const earlier of [slash, question, hash]) {
    if (earlier > -1 && earlier < colon) return true;
  }
  return protocols.includes(cleaned.slice(0, colon).toLowerCase());
}

function sanitizeProperties(element: Element, schema: SanitizeSchema): Element['properties'] {
  const allowed = new Set([
    ...(schema.attributes['*'] ?? []),
    ...(schema.attributes[element.tagName] ?? []),
  ]);
  const out: Element['properties'] = {};
  for (const [property, value] of Object.entries(element.properties ?? {})) {
    if (!allowed.has(property)) continue;
    if (value === null || value === undefined) continue;
    const protocols = schema.protocols[property];
    if (protocols && !isAllowedUrl(String(value), protocols)) continue;
    out[property] = value;
  }
  return out;
}

function sanitizeChildren(
  children: readonly (RootContent | ElementContent)[],
  schema: SanitizeSchema,
): ElementContent[] {
  const out: ElementContent[] = [];
  for (const child of children) {
    if (child.type === 'text') {
      out.push(child);
      continue;
    }
    if (child.type === 'element') {
      const kids = sanitizeChildren(child.children, schema);
      if (!schema.tagNames.includes(child.tagName)) {
        // Unwrap rather than delete: the prose inside an unexpected wrapper is
        // still the author's content.
        out.push(...kids);
        continue;
      }
      out.push({ ...child, properties: sanitizeProperties(child, schema), children: kids });
      continue;
    }
    // `raw`, `comment`, `doctype` and anything else is dropped outright.
  }
  return out;
}

/** Return a sanitized copy of `tree`; the input is not mutated. */
export function sanitize(tree: Root, schema: SanitizeSchema = DEFAULT_SCHEMA): Root {
  return { ...tree, children: sanitizeChildren(tree.children, schema) };
}

/** unified-compatible transform plugin: `.use(rehypeSanitize, schema)`. */
export function rehypeSanitize(schema: SanitizeSchema = DEFAULT_SCHEMA) {
  return (tree: Root): Root => sanitize(tree, schema);
}
