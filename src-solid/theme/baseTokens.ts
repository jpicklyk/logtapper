/**
 * The built-in themes' resolved values for the handful of tokens the theme
 * editor needs a *counterpart* for when it scores contrast.
 *
 * Why a table and not `getComputedStyle(document.documentElement)`: the editor
 * scores a **draft** theme, which may declare a different `base` than the one
 * currently painted. Reading the live root answers "what does this value look
 * like against the theme the app happens to be running", which is the wrong
 * question and — because `getComputedStyle` is external mutable state — is also
 * invisible to Solid's reactivity (root CLAUDE.md, "No reading external mutable
 * state in useMemo/render").
 *
 * Drift is caught rather than assumed: `tokens.contrast.test.ts` parses
 * `styles/tokens.css`, resolves its `var(--p-*)` chains per `[data-theme]`, and
 * asserts every entry below still matches.
 */
import type { ThemeBase } from './applyTheme';

/** Tokens a draft's contrast badges resolve a counterpart from. */
export type BaseContrastToken = '--surface' | '--text';

export const BASE_THEME_TOKENS: Readonly<Record<ThemeBase, Readonly<Record<BaseContrastToken, string>>>> = {
  dark: { '--surface': '#0c1014', '--text': '#b8c4ce' },
  light: { '--surface': '#ffffff', '--text': '#1a1f26' },
  'dark-hc': { '--surface': '#0c1014', '--text': '#ffffff' },
  'light-hc': { '--surface': '#ffffff', '--text': '#000000' },
};

/**
 * A draft's effective value for `token`: its own override when it declares one,
 * otherwise the value its declared `base` would paint.
 */
export function effectiveTokenValue(
  base: ThemeBase,
  tokens: Readonly<Record<string, string>>,
  token: BaseContrastToken,
): string {
  const own = tokens[token]?.trim();
  return own || BASE_THEME_TOKENS[base][token];
}
