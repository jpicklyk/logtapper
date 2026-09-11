import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio } from './contrast';

/**
 * Parses styles/tokens.css directly (no hand-maintained JS mirror of the
 * palette — this test would not catch drift if it re-typed the values) and
 * asserts every foreground token required to carry text or a glyph keeps
 * AA contrast against both surface tokens, in every built-in theme.
 */

const TOKENS_CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../styles/tokens.css');

interface CssBlock {
  selectors: string[];
  decls: Map<string, string>;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  const uncommented = stripComments(css);
  // No selector in this file nests braces inside a block (color-mix()/rgba() use
  // only parens), so a non-greedy match across `{...}` is safe here.
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(uncommented))) {
    const selectorPart = match[1].trim();
    const body = match[2];
    if (!selectorPart || selectorPart.startsWith('@')) continue;
    const selectors = selectorPart.split(',').map((s) => s.trim());
    const decls = new Map<string, string>();
    const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let declMatch: RegExpExecArray | null;
    while ((declMatch = declRe.exec(body))) {
      decls.set(declMatch[1], declMatch[2].trim());
    }
    blocks.push({ selectors, decls });
  }
  return blocks;
}

function blockAppliesToTheme(selectors: string[], theme: string): boolean {
  return selectors.some((sel) => sel === ':root' || sel === `[data-theme='${theme}']` || sel === `[data-theme="${theme}"]`);
}

/** Builds the flattened custom-property map that would be visible on `[data-theme="theme"]` (i.e. `:root` declarations plus that theme's own block, later declarations winning). */
function buildThemeVars(blocks: CssBlock[], theme: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const block of blocks) {
    if (!blockAppliesToTheme(block.selectors, theme)) continue;
    for (const [name, value] of block.decls) {
      vars.set(name, value);
    }
  }
  return vars;
}

function resolveValue(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 10) throw new Error(`resolveValue: var() chain too deep resolving "${value}"`);
  const varRe = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g;
  let result = value;
  let didReplace = false;
  result = result.replace(varRe, (_full, name: string, fallback: string | undefined) => {
    didReplace = true;
    if (vars.has(name)) return vars.get(name) as string;
    if (fallback !== undefined) return fallback.trim();
    throw new Error(`resolveValue: unresolved custom property "${name}"`);
  });
  return didReplace ? resolveValue(result, vars, depth + 1) : result;
}

const THEMES = ['dark', 'light', 'dark-hc', 'light-hc'] as const;

// Every token the task requires AA for: level foregrounds, status colours, accent, and the text ramp.
const REQUIRED_FOREGROUND_TOKENS = [
  '--level-verbose',
  '--level-debug',
  '--level-info',
  '--level-warning',
  '--level-error',
  '--level-fatal',
  '--danger',
  '--success',
  '--warning',
  '--accent',
  '--text',
  '--text-subtle',
  '--text-muted',
] as const;

const SURFACE_TOKENS = ['--surface', '--surface-raised'] as const;

describe('tokens.css AA contrast', () => {
  const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
  const blocks = parseBlocks(css);

  for (const theme of THEMES) {
    describe(`[data-theme="${theme}"]`, () => {
      const vars = buildThemeVars(blocks, theme);

      it('defines both surface tokens', () => {
        for (const surfaceToken of SURFACE_TOKENS) {
          expect(vars.has(surfaceToken), `${theme} is missing ${surfaceToken}`).toBe(true);
        }
      });

      for (const token of REQUIRED_FOREGROUND_TOKENS) {
        for (const surfaceToken of SURFACE_TOKENS) {
          it(`${token} keeps AA (>= ${AA_NORMAL_TEXT}:1) against ${surfaceToken}`, () => {
            expect(vars.has(token), `${theme} is missing ${token}`).toBe(true);
            const fg = resolveValue(vars.get(token) as string, vars);
            const bg = resolveValue(vars.get(surfaceToken) as string, vars);
            const ratio = contrastRatio(fg, bg);
            expect(
              ratio,
              `${theme} ${token} (${fg}) vs ${surfaceToken} (${bg}) = ${ratio.toFixed(2)}:1, below AA`,
            ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
          });
        }
      }
    });
  }
});
