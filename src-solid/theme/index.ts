/**
 * Public API of `src-solid/theme/`.
 *
 * Root CLAUDE.md rule 9: everything outside this directory imports from this
 * barrel only (`App.tsx`, `main.tsx`, `settings/`). Files inside `theme/`
 * import each other directly.
 */

export {
  applyTheme,
  applyDensity,
  createThemeController,
  isDensity,
  isThemeMode,
  resolveTheme,
  BASE_THEMES,
  THEME_STORAGE_KEY,
  DENSITY_STORAGE_KEY,
  APPLIED_THEME_STORAGE_KEY,
} from './applyTheme';
export type {
  AppliedUserTheme,
  ApplyThemeOptions,
  Density,
  ThemeBase,
  ThemeController,
  ThemeControllerOptions,
  ThemeMode,
} from './applyTheme';

export { BASE_THEME_TOKENS, effectiveTokenValue } from './baseTokens';
export type { BaseContrastToken } from './baseTokens';

export { AA_NORMAL_TEXT, contrastRatio, hexToRgb, relativeLuminance } from './contrast';
export type { Rgb } from './contrast';

export {
  InMemoryThemeSource,
  KNOWN_TOKENS,
  isValidTokenValue,
  loadUserTheme,
  validateUserTheme,
} from './userTheme';
export type { ThemeSource, UserTheme, ValidationResult } from './userTheme';
