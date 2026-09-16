import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * C4 (light-mode verification) acceptance criterion: zero literal colours in
 * `.module.css` outside tokens — every colour value must come from a design
 * token, with a raw hex/rgb(a) literal allowed only as a `var(--x, <literal>)`
 * fallback (the P3 back-compat pattern documented at the top of
 * viewer/LogViewer.module.css). A literal used directly, or alongside a var()
 * in the same declaration rather than inside its fallback slot, bypasses
 * theming and can't be told apart from a light/dark-specific value by grep.
 *
 * This walks every `*.module.css` under src-solid and fails on any hex or
 * rgb()/rgba() literal whose position isn't inside some `var(...)` call's
 * parentheses (nested var() fallbacks included).
 */

const SRC_SOLID_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

function findModuleCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...findModuleCssFiles(full));
    } else if (entry.endsWith('.module.css')) {
      out.push(full);
    }
  }
  return out;
}

/** Balanced-paren spans for every `var(` call in `css`, nested ones included — a literal at any position inside one of these spans is a var() argument (i.e. a fallback), not a bare value. */
function varCallSpans(css: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const varStartRe = /var\(/g;
  let match: RegExpExecArray | null;
  while ((match = varStartRe.exec(css))) {
    const start = match.index;
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === '(') depth++;
      else if (css[i] === ')') depth--;
      i++;
    }
    spans.push([start, i]);
  }
  return spans;
}

function isInsideAnySpan(pos: number, spans: Array<[number, number]>): boolean {
  return spans.some(([start, end]) => pos > start && pos < end);
}

function lineNumberAt(css: string, pos: number): number {
  return css.slice(0, pos).split('\n').length;
}

const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g;

describe('no raw colour literals outside var() fallbacks (src-solid/**/*.module.css)', () => {
  const files = findModuleCssFiles(SRC_SOLID_DIR);

  it('found module.css files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relPath = file.slice(SRC_SOLID_DIR.length + 1).replace(/\\/g, '/');
    it(`${relPath} has no bare colour literal`, () => {
      const raw = readFileSync(file, 'utf8');
      const css = stripComments(raw);
      const spans = varCallSpans(css);

      const violations: string[] = [];
      let match: RegExpExecArray | null;
      COLOR_LITERAL_RE.lastIndex = 0;
      while ((match = COLOR_LITERAL_RE.exec(css))) {
        if (!isInsideAnySpan(match.index, spans)) {
          violations.push(`line ${lineNumberAt(css, match.index)}: "${match[0]}"`);
        }
      }

      expect(violations, `${relPath} has colour literal(s) outside a var() fallback:\n${violations.join('\n')}`).toEqual([]);
    });
  }
});
