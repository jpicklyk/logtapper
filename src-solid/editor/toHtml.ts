/**
 * hast → HTML string.
 *
 * This is a local stand-in for `rehype-stringify`. Plan §G assumed
 * `rehype-stringify` / `hast-util-to-html` were already in the lockfile because
 * react-markdown pulls them in — they are not (react-markdown v10 renders
 * straight to JSX via `hast-util-to-jsx-runtime` and never serializes HTML).
 * Adding them would change `package-lock.json`, which this package may not do,
 * so the serializer lives here instead.
 *
 * It only has to cover what `mdast-util-to-hast` + `remark-gfm` + `lineRefs`
 * can produce, and it runs *after* `sanitize`, so the tag and attribute space is
 * already an allowlist by the time a node reaches it.
 */

import type { Element, Nodes, Parents, Root, RootContent } from 'hast';

/** HTML elements that must be serialized without a closing tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

/**
 * The two hast property names that do not simply lowercase to their attribute.
 * Everything else in markdown output (`rowSpan`, `colSpan`, `ariaHidden`, …)
 * is the camelCase DOM name of a lowercase HTML attribute, and `data*` follows
 * the `data-*` rule below.
 */
const PROPERTY_ATTRIBUTES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
};

/** `dataSession` → `data-session`, `ariaHidden` → `aria-hidden`. */
export function attributeName(property: string): string {
  const mapped = PROPERTY_ATTRIBUTES[property];
  if (mapped) return mapped;
  if (/^(data|aria)[A-Z]/.test(property)) {
    return property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  }
  return property.toLowerCase();
}

/** Text-node escaping. `>` is escaped too so a stray `]]>` cannot reopen markup. */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function serializeProperties(properties: Element['properties']): string {
  const out: string[] = [];
  for (const [property, raw] of Object.entries(properties ?? {})) {
    if (raw === null || raw === undefined || raw === false) continue;
    const name = attributeName(property);
    if (raw === true) {
      out.push(` ${name}`);
      continue;
    }
    const value = Array.isArray(raw) ? raw.join(' ') : String(raw);
    out.push(` ${name}="${escapeAttribute(value)}"`);
  }
  return out.join('');
}

function serializeChildren(node: Parents): string {
  return node.children.map((child) => serializeNode(child as Nodes)).join('');
}

function serializeNode(node: Nodes): string {
  switch (node.type) {
    case 'root':
      return serializeChildren(node as Root);
    case 'text':
      return escapeText(node.value);
    case 'comment':
      return '';
    case 'element': {
      const element = node as Element;
      const open = `<${element.tagName}${serializeProperties(element.properties)}>`;
      if (VOID_ELEMENTS.has(element.tagName)) return open;
      return `${open}${serializeChildren(element)}</${element.tagName}>`;
    }
    default:
      // `raw` (only produced with allowDangerousHtml) and anything unknown is
      // dropped rather than passed through — sanitize already removes these,
      // this is the belt to its braces.
      return '';
  }
}

/** Serialize a (sanitized) hast tree to an HTML string. */
export function toHtml(tree: Root | RootContent): string {
  return serializeNode(tree as Nodes);
}

/** unified-compatible compiler plugin: `.use(rehypeStringify)`. */
export function rehypeStringify(this: { compiler?: unknown }): void {
  this.compiler = (tree: Nodes) => toHtml(tree as Root);
}
