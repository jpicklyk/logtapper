/**
 * Sanitize schema for the markdown pipeline.
 *
 * Derived from `rehype-sanitize`'s `defaultSchema` (GitHub-style sanitation —
 * already zero `style`, zero `on*` handler attributes, raw `<script>` stripped
 * entirely, every other unrecognised element unwrapped rather than deleted) and
 * tightened in the two places this app needs to go further than GitHub does:
 *
 *   1. `href`/`src` protocols are narrowed to `http`, `https`, `mailto` (GitHub's
 *      default also allows `irc`, `ircs`, `xmpp` on `href`, which this app has no
 *      use for). Relative and same-document URLs are unaffected — the protocol
 *      check only applies once a colon-delimited scheme is present.
 *   2. `a` gains the attributes `lineRefs.ts` writes on a line-reference anchor
 *      (`className` with the literal `lt-line-ref` value, `role`, `tabIndex`,
 *      `dataSession`, `dataLine`, `dataEndLine`, `dataAnchor`,
 *      `dataUnresolved`) — `rehypeLineRefs` must run before this schema is
 *      applied, or these attributes are stripped like any other. `className` on
 *      `a` isn't in `defaultSchema` at all beyond the exact GFM footnote value
 *      `data-footnote-backref`, so it is replaced with a value-list definition
 *      that keeps that value and adds `lt-line-ref`.
 *
 * Nothing else is removed from the default: the extra tags GitHub allows beyond
 * this app's old hand-rolled allowlist (`div`, `details`/`summary`, `b`/`i`/`s`,
 * `kbd`, `picture`, `q`, `ruby`/`rp`/`rt`, …) carry no exploitable attributes
 * under this schema, so keeping them is not a widening of the attack surface —
 * it is `rehype-sanitize` doing a more thorough job on the same surface.
 */

import { defaultSchema } from 'rehype-sanitize';
import type { Options } from 'rehype-sanitize';
import { LINE_REF_CLASS } from './lineRefs';

export type SanitizeSchema = Options;

const SAFE_URL_PROTOCOLS = ['http', 'https', 'mailto'];

/** Attributes `lineRefs.ts` puts on a generated line-reference anchor, beyond `className`. */
const LINE_REF_ATTRIBUTES = [
  'role',
  'tabIndex',
  'dataSession',
  'dataLine',
  'dataEndLine',
  'dataAnchor',
  'dataUnresolved',
];

const DEFAULT_A_ATTRIBUTES = defaultSchema.attributes?.a ?? [];

/** `defaultSchema`'s `a` attributes, minus its `className` rule — replaced below. */
const A_ATTRIBUTES_WITHOUT_CLASS_NAME = DEFAULT_A_ATTRIBUTES.filter(
  (entry) => !(Array.isArray(entry) && entry[0] === 'className'),
);

export const DEFAULT_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [
      ...A_ATTRIBUTES_WITHOUT_CLASS_NAME,
      // Keep the GFM footnote back-reference class defaultSchema allows, and
      // add the one lineRefs.ts generates. A value-list definition (more than
      // one item after the key) permits only these exact values.
      ['className', 'data-footnote-backref', LINE_REF_CLASS],
      ...LINE_REF_ATTRIBUTES,
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: SAFE_URL_PROTOCOLS,
    src: SAFE_URL_PROTOCOLS,
  },
};
