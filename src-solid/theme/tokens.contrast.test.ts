import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio } from './contrast';
import { BASE_THEME_TOKENS } from './baseTokens';

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
  '--brand',
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

/**
 * `baseTokens.ts` hand-writes the resolved `--surface`/`--text` for each built-in
 * theme so the theme editor can score a *draft* without reading the painted DOM.
 * A hand-written table is only safe if drift is caught, which is what this does:
 * the same parser above resolves tokens.css's `var(--p-*)` chains and the two
 * must agree.
 */
describe('BASE_THEME_TOKENS matches styles/tokens.css', () => {
  const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
  const blocks = parseBlocks(css);

  for (const theme of THEMES) {
    const vars = buildThemeVars(blocks, theme);
    for (const token of ['--surface', '--text'] as const) {
      it(`${theme} ${token}`, () => {
        expect(BASE_THEME_TOKENS[theme][token]).toBe(resolveValue(vars.get(token) as string, vars));
      });
    }
  }
});

/**
 * C4 finding D1: `--text-dimmed` (uninitialised device-state fields, empty-state
 * copy, etc.) is not in REQUIRED_FOREGROUND_TOKENS above because the dark family
 * intentionally keeps it below AA (a deliberately faint token, unchanged by this
 * fix — see tokens.css block B). Light and light-hc are pinned here instead: at
 * --p-gray-300 both used to resolve to the same 3.04:1-on-white value, which was
 * both below AA and made the HC variant no more legible than the non-HC one.
 */
describe('--text-dimmed (light family, C4 finding D1)', () => {
  const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
  const blocks = parseBlocks(css);
  const light = buildThemeVars(blocks, 'light');
  const lightHc = buildThemeVars(blocks, 'light-hc');

  for (const [theme, vars] of [
    ['light', light],
    ['light-hc', lightHc],
  ] as const) {
    for (const surfaceToken of SURFACE_TOKENS) {
      it(`${theme} --text-dimmed keeps AA (>= ${AA_NORMAL_TEXT}:1) against ${surfaceToken}`, () => {
        const fg = resolveValue(vars.get('--text-dimmed') as string, vars);
        const bg = resolveValue(vars.get(surfaceToken) as string, vars);
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${theme} --text-dimmed (${fg}) vs ${surfaceToken} (${bg}) = ${ratio.toFixed(2)}:1, below AA`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  it('light-hc is materially darker (higher contrast) than light on --surface', () => {
    const lightFg = resolveValue(light.get('--text-dimmed') as string, light);
    const lightBg = resolveValue(light.get('--surface') as string, light);
    const hcFg = resolveValue(lightHc.get('--text-dimmed') as string, lightHc);
    const hcBg = resolveValue(lightHc.get('--surface') as string, lightHc);
    const lightRatio = contrastRatio(lightFg, lightBg);
    const hcRatio = contrastRatio(hcFg, hcBg);
    expect(hcRatio, `light-hc --text-dimmed (${hcRatio.toFixed(2)}:1) should exceed light's (${lightRatio.toFixed(2)}:1)`).toBeGreaterThan(
      lightRatio,
    );
  });
});

/**
 * C4 finding D3: light-hc read as visually almost identical to light. The
 * dark-hc block redeclares every one of these keys with a value that differs
 * from dark's — that's what "high contrast" means for this token. This pins
 * the same expectation for light-hc against light so the two families can't
 * drift apart again (a token added to dark-hc's differentiation set but never
 * mirrored into light-hc would fail this immediately).
 */
describe('high-contrast variants actually differ from their base theme (C4 finding D3)', () => {
  const css = readFileSync(TOKENS_CSS_PATH, 'utf8');
  const blocks = parseBlocks(css);

  const HC_DIFFERENTIATION_TOKENS = [
    '--border',
    '--border-subtle',
    '--text',
    '--text-subtle',
    '--text-muted',
    '--accent',
    '--danger',
    '--success',
    '--warning',
    '--selection',
    '--focus-ring',
    '--level-verbose',
    '--level-debug',
  ] as const;

  const PAIRS = [
    ['dark', 'dark-hc'],
    ['light', 'light-hc'],
  ] as const;

  for (const [base, hc] of PAIRS) {
    const baseVars = buildThemeVars(blocks, base);
    const hcVars = buildThemeVars(blocks, hc);

    for (const token of HC_DIFFERENTIATION_TOKENS) {
      it(`${hc} ${token} differs from ${base}`, () => {
        const baseValue = resolveValue(baseVars.get(token) as string, baseVars);
        const hcValue = resolveValue(hcVars.get(token) as string, hcVars);
        expect(hcValue, `${hc} ${token} (${hcValue}) is identical to ${base} (${baseValue})`).not.toBe(baseValue);
      });
    }
  }
});
