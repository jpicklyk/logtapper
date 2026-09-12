/**
 * Line references inside markdown prose.
 *
 * In the React reader (`components/AnalysisReader/MarkdownSection.tsx`), a
 * section's `SourceReference[]` renders as a row of `LineReference` chip buttons
 * *above* the body, and the body markdown itself is inert. The Solid reader keeps
 * that chip row (see `AnalysisSectionView.tsx`) but also makes the same reference
 * clickable where it is *mentioned* in the prose, which is what this rehype pass
 * adds.
 *
 * The text pattern is `LineReference`'s, reproduced exactly:
 *
 *   endLine == null  →  `L{lineNumber}`          e.g. `L482`
 *   endLine != null  →  `L{lineNumber}–{endLine}` e.g. `L482–495`  (EN DASH U+2013)
 *
 * A match only becomes an anchor when it corresponds to a reference that was
 * actually passed in — prose that happens to contain `L12` with no such reference
 * is left as text. Matches inside `<code>` / `<pre>` are skipped, so a line of a
 * code fence that reads `L482` stays code.
 */

import type { Element as HastElement, Root, RootContent, Text } from 'hast';

/** The `SourceReference` shape this pass needs — structurally compatible with `@bridge/types`. */
export interface LineRefSource {
  lineNumber: number;
  endLine?: number | null;
  label?: string;
  /** `'Anchor'` renders as the emphasised chip; `'Annotation'` is the plain one. */
  highlightType?: 'Anchor' | 'Annotation' | string;
  sessionId?: string | null;
  /** Whether `sessionId` maps to a currently-open session (precomputed, as in React). */
  resolved?: boolean;
}

export interface LineRefOptions {
  references: readonly LineRefSource[];
  /** Class put on every generated anchor. Global, so a plain `.ts` pass can set it. */
  className?: string;
}

/** The class name the generated anchors carry; `Markdown.module.css` styles it. */
export const LINE_REF_CLASS = 'lt-line-ref';

/** Both dash forms are accepted on input; output always uses the EN DASH. */
const LINE_REF_PATTERN = /L(\d+)(?:[–—-](\d+))?/g;

const CODE_TAGS = new Set(['code', 'pre']);

/** `L482` / `L482–495` — byte-for-byte what `LineReference` renders. */
export function lineRefText(reference: LineRefSource): string {
  return reference.endLine != null
    ? `L${reference.lineNumber}–${reference.endLine}`
    : `L${reference.lineNumber}`;
}

/**
 * The `title` LineReference puts on the chip — the label when the reference can
 * be jumped to, the explanation when it cannot.
 */
export function lineRefTitle(reference: LineRefSource): string {
  return reference.resolved === false
    ? "Source file is not open — this reference can't be resolved"
    : (reference.label ?? lineRefText(reference));
}

function findReference(
  references: readonly LineRefSource[],
  lineNumber: number,
  endLine: number | null,
): LineRefSource | undefined {
  return references.find(
    (r) => r.lineNumber === lineNumber && (r.endLine ?? null) === endLine,
  );
}

/** Build the anchor element for one matched reference. */
export function lineRefAnchor(reference: LineRefSource, className: string): HastElement {
  const properties: HastElement['properties'] = {
    className: [className],
    role: 'link',
    tabIndex: 0,
    title: lineRefTitle(reference),
    dataLine: String(reference.lineNumber),
  };
  if (reference.sessionId != null) properties.dataSession = reference.sessionId;
  if (reference.endLine != null) properties.dataEndLine = String(reference.endLine);
  if (reference.highlightType === 'Anchor') properties.dataAnchor = 'true';
  if (reference.resolved === false) properties.dataUnresolved = 'true';

  return {
    type: 'element',
    tagName: 'a',
    properties,
    children: [{ type: 'text', value: lineRefText(reference) }],
  };
}

/** Split one text node into text + anchor nodes. Returns `null` when nothing matched. */
function splitTextNode(
  node: Text,
  references: readonly LineRefSource[],
  className: string,
): RootContent[] | null {
  LINE_REF_PATTERN.lastIndex = 0;
  const out: RootContent[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = LINE_REF_PATTERN.exec(node.value)) !== null) {
    const reference = findReference(
      references,
      Number(match[1]),
      match[2] === undefined ? null : Number(match[2]),
    );
    if (!reference) continue;
    if (match.index > cursor) {
      out.push({ type: 'text', value: node.value.slice(cursor, match.index) });
    }
    out.push(lineRefAnchor(reference, className));
    cursor = match.index + match[0].length;
  }

  if (out.length === 0) return null;
  if (cursor < node.value.length) {
    out.push({ type: 'text', value: node.value.slice(cursor) });
  }
  return out;
}

function transformChildren(
  parent: Root | HastElement,
  references: readonly LineRefSource[],
  className: string,
): void {
  const next: RootContent[] = [];
  for (const child of parent.children) {
    if (child.type === 'text') {
      const replacement = splitTextNode(child, references, className);
      if (replacement) next.push(...replacement);
      else next.push(child);
      continue;
    }
    if (child.type === 'element') {
      // Never rewrite inside code — a fence that prints `L482` is code, not a link.
      // Nor inside an anchor we (or the author) already made.
      if (!CODE_TAGS.has(child.tagName) && child.tagName !== 'a') {
        transformChildren(child, references, className);
      }
    }
    next.push(child);
  }
  parent.children = next;
}

/**
 * unified transform plugin: `.use(rehypeLineRefs, { references })`.
 *
 * Must run *before* `rehypeSanitize`; the sanitize schema is what permits the
 * `data-session` / `data-line` attributes this writes and nothing else.
 */
export function rehypeLineRefs(options: LineRefOptions) {
  const className = options.className ?? LINE_REF_CLASS;
  return (tree: Root) => {
    if (options.references.length === 0) return tree;
    transformChildren(tree, options.references, className);
    return tree;
  };
}

/** The target a click on a generated anchor resolves to. */
export interface LineRefTarget {
  sessionId: string | null;
  line: number;
  endLine: number | null;
}

/**
 * Read a click target back off the DOM. Returns `null` when the click did not
 * land on (or inside) a generated anchor, or when the anchor is unresolved.
 */
export function lineRefTargetFrom(
  target: EventTarget | null,
  className: string = LINE_REF_CLASS,
): LineRefTarget | null {
  if (!(target instanceof globalThis.Element)) return null;
  const anchor = target.closest(`a.${className}`);
  if (anchor === null) return null;
  if (anchor.getAttribute('data-unresolved') === 'true') return null;
  const line = Number(anchor.getAttribute('data-line'));
  if (!Number.isFinite(line)) return null;
  const endLine = anchor.getAttribute('data-end-line');
  return {
    sessionId: anchor.getAttribute('data-session'),
    line,
    endLine: endLine === null ? null : Number(endLine),
  };
}
