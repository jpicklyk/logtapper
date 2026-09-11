/**
 * User theme JSON schema, validation, and the (not-yet-backed) theme
 * source. A user theme is `{ name, base, tokens }` stored at
 * `{app_data_dir}/themes/<slug>.json` — see plans/ui-phase2a-spike-foundation.md
 * §D. `services/themes.rs` + the Tauri commands + `GET /mcp/themes*` are
 * B2's job; `ThemeSource` is the seam B2 fills in.
 */
import { BASE_THEMES, type ApplyThemeOptions, type ThemeBase } from './applyTheme';

export interface UserTheme {
  name: string;
  base: ThemeBase;
  tokens: Record<string, string>;
}

/**
 * Every custom property a user theme may override — the semantic and
 * domain layers of styles/tokens.css, plus the back-compat aliases (all of
 * which resolve to plain colours). Primitives (`--p-*`) are internal and
 * not overridable. `--shadow`, `--font-ui`, `--font-mono` are excluded:
 * their natural values aren't a single colour or length, so no value would
 * ever pass `isValidTokenValue` for them (see below) — kept out of the
 * allowlist rather than silently always-rejected.
 */
export const KNOWN_TOKENS: ReadonlySet<string> = new Set([
  // Semantic
  '--surface',
  '--surface-raised',
  '--surface-overlay',
  '--surface-input',
  '--border',
  '--border-subtle',
  '--text',
  '--text-subtle',
  '--text-muted',
  '--text-dimmed',
  '--accent',
  '--accent-base',
  '--accent-muted',
  '--accent-border',
  '--text-on-accent',
  '--danger',
  '--danger-muted',
  '--success',
  '--success-muted',
  '--warning',
  '--warning-muted',
  '--selection',
  '--focus-ring',
  // Domain
  '--level-verbose',
  '--level-debug',
  '--level-info',
  '--level-warning',
  '--level-error',
  '--level-fatal',
  '--level-verbose-bg',
  '--level-debug-bg',
  '--level-info-bg',
  '--level-warning-bg',
  '--level-error-bg',
  '--level-fatal-bg',
  '--match',
  '--pii',
  '--watch-match',
  '--bookmark-1',
  '--bookmark-2',
  '--bookmark-3',
  '--bookmark-4',
  '--bookmark-5',
  '--bookmark-6',
  '--processor-reporter',
  '--processor-tracker',
  '--processor-correlator',
  '--processor-transformer',
  '--agent-idle',
  '--agent-reading',
  '--agent-running',
  '--agent-wrote',
  '--agent-needs',
  '--agent-raw',
  '--caller-human',
  '--caller-agent',
  '--diff-added',
  '--diff-removed',
  // Back-compat aliases (src-solid/viewer + App consume these directly)
  '--bg-base',
  '--bg-raised',
  '--bg-overlay',
  '--bg-input',
  '--viewer-bg',
  '--viewer-gutter-text',
  '--viewer-selection-bg',
  '--viewer-selection-border',
  '--chrome-bg',
  '--hl-search',
  '--hl-search-active',
  '--hl-pii',
]);

const COLOR_RE =
  /^(#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\)|hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(,\s*[\d.]+%?\s*)?\)|transparent|currentColor)$/i;
const LENGTH_RE = /^-?\d*\.?\d+(px|rem|em|%|vh|vw)$/;

export function isValidTokenValue(value: string): boolean {
  const trimmed = value.trim();
  return COLOR_RE.test(trimmed) || LENGTH_RE.test(trimmed);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  theme?: UserTheme;
}

/** Validates an arbitrary JSON value against the user-theme schema: object shape, a known `base`, and every `tokens` entry both a known token name and a colour/length value. Unknown keys and invalid values are collected as errors rather than throwing, so a caller can show every problem at once. */
export function validateUserTheme(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['theme must be a JSON object'] };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    errors.push('"name" must be a non-empty string');
  }

  if (typeof obj.base !== 'string' || !(BASE_THEMES as readonly string[]).includes(obj.base)) {
    errors.push(`"base" must be one of ${BASE_THEMES.join(', ')}`);
  }

  const tokens: Record<string, string> = {};
  if (obj.tokens !== undefined) {
    if (typeof obj.tokens !== 'object' || obj.tokens === null || Array.isArray(obj.tokens)) {
      errors.push('"tokens" must be an object');
    } else {
      for (const [key, value] of Object.entries(obj.tokens as Record<string, unknown>)) {
        if (!KNOWN_TOKENS.has(key)) {
          errors.push(`unknown token "${key}"`);
          continue;
        }
        if (typeof value !== 'string' || !isValidTokenValue(value)) {
          errors.push(`invalid value for "${key}": ${JSON.stringify(value)} is not a colour or length`);
          continue;
        }
        tokens[key] = value.trim();
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    theme: { name: (obj.name as string).trim(), base: obj.base as ThemeBase, tokens },
  };
}

/** Validates `json` and, if valid, maps it to `applyTheme`'s options shape. Returns `null` on any validation failure — callers that need the reasons should call `validateUserTheme` directly. */
export function loadUserTheme(json: unknown): ApplyThemeOptions | null {
  const result = validateUserTheme(json);
  if (!result.valid || !result.theme) return null;
  return { base: result.theme.base, overrides: result.theme.tokens };
}

/**
 * Storage seam for user themes. B2 (`services/themes.rs`, Tauri commands,
 * `GET /mcp/themes` + `GET /mcp/themes/{slug}`) provides the real
 * implementation; `InMemoryThemeSource` lets Settings UI work (S1/wave-3)
 * develop against this interface today.
 */
export interface ThemeSource {
  list(): Promise<UserTheme[]>;
  read(slug: string): Promise<UserTheme | null>;
  write(slug: string, theme: UserTheme): Promise<void>;
  delete(slug: string): Promise<void>;
}

/**
 * In-memory `ThemeSource`. Not persisted across reloads — a placeholder
 * until B2's backend lands.
 *
 * TODO(B2): swap for a `ThemeSource` backed by `@bridge/commands` calls to
 * the Tauri `list_themes`/`read_theme`/`write_theme`/`delete_theme`
 * commands (mirroring how src-solid/App.tsx already wires `getLines`/
 * `loadLogFile`), once services/themes.rs + those commands exist. Writes
 * are `Ui`-only on the backend (`deny_agent_gate_mutation`-style check) —
 * this in-memory stand-in has no such gate and must not be treated as the
 * real persistence layer.
 */
export class InMemoryThemeSource implements ThemeSource {
  private readonly store = new Map<string, UserTheme>();

  async list(): Promise<UserTheme[]> {
    return Array.from(this.store.values());
  }

  async read(slug: string): Promise<UserTheme | null> {
    return this.store.get(slug) ?? null;
  }

  async write(slug: string, theme: UserTheme): Promise<void> {
    this.store.set(slug, theme);
  }

  async delete(slug: string): Promise<void> {
    this.store.delete(slug);
  }
}
