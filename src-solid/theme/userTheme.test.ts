import { describe, expect, it } from 'vitest';
import { InMemoryThemeSource, isValidTokenValue, loadUserTheme, validateUserTheme } from './userTheme';

const VALID_THEME = {
  name: 'My Dark',
  base: 'dark',
  tokens: {
    '--accent': '#ff8800',
    '--level-error': '#ff0000',
  },
};

describe('isValidTokenValue', () => {
  it('accepts hex colours of every supported length', () => {
    expect(isValidTokenValue('#fff')).toBe(true);
    expect(isValidTokenValue('#ffffff')).toBe(true);
    expect(isValidTokenValue('#ffffffcc')).toBe(true);
  });

  it('accepts rgb()/rgba()', () => {
    expect(isValidTokenValue('rgb(1, 2, 3)')).toBe(true);
    expect(isValidTokenValue('rgba(1, 2, 3, 0.5)')).toBe(true);
  });

  it('accepts lengths', () => {
    expect(isValidTokenValue('12px')).toBe(true);
    expect(isValidTokenValue('1.5rem')).toBe(true);
    expect(isValidTokenValue('100%')).toBe(true);
  });

  it('rejects non-colour, non-length values', () => {
    expect(isValidTokenValue('url(evil.png)')).toBe(false);
    expect(isValidTokenValue('javascript:alert(1)')).toBe(false);
    expect(isValidTokenValue('bold')).toBe(false);
    expect(isValidTokenValue('')).toBe(false);
  });
});

describe('validateUserTheme', () => {
  it('accepts a well-formed theme', () => {
    const result = validateUserTheme(VALID_THEME);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.theme).toEqual({
      name: 'My Dark',
      base: 'dark',
      tokens: { '--accent': '#ff8800', '--level-error': '#ff0000' },
    });
  });

  it('accepts a theme with no tokens', () => {
    const result = validateUserTheme({ name: 'Plain', base: 'light' });
    expect(result.valid).toBe(true);
    expect(result.theme?.tokens).toEqual({});
  });

  it('rejects a non-object input', () => {
    expect(validateUserTheme('not an object').valid).toBe(false);
    expect(validateUserTheme(null).valid).toBe(false);
    expect(validateUserTheme([1, 2, 3]).valid).toBe(false);
  });

  it('rejects a missing or empty name', () => {
    const result = validateUserTheme({ base: 'dark', tokens: {} });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"name"'))).toBe(true);
  });

  it('rejects an invalid base', () => {
    const result = validateUserTheme({ name: 'x', base: 'purple', tokens: {} });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"base"'))).toBe(true);
  });

  it('rejects an unknown token name', () => {
    const result = validateUserTheme({ name: 'x', base: 'dark', tokens: { '--not-a-real-token': '#fff' } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown token'))).toBe(true);
  });

  it('rejects a non-colour, non-length value for a known token', () => {
    const result = validateUserTheme({ name: 'x', base: 'dark', tokens: { '--accent': 'url(evil.png)' } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('--accent'))).toBe(true);
  });

  it('rejects a non-string token value', () => {
    const result = validateUserTheme({ name: 'x', base: 'dark', tokens: { '--accent': 12345 } });
    expect(result.valid).toBe(false);
  });

  it('collects multiple errors at once', () => {
    const result = validateUserTheme({
      base: 'nope',
      tokens: { '--bogus': '#fff', '--accent': 'not-a-colour' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('loadUserTheme', () => {
  it('maps a valid theme to ApplyThemeOptions', () => {
    const options = loadUserTheme(VALID_THEME);
    expect(options).toEqual({
      base: 'dark',
      overrides: { '--accent': '#ff8800', '--level-error': '#ff0000' },
    });
  });

  it('returns null for an invalid theme', () => {
    expect(loadUserTheme({ base: 'not-a-theme' })).toBeNull();
    expect(loadUserTheme('nope')).toBeNull();
  });
});

describe('InMemoryThemeSource', () => {
  it('round-trips list/read/write/delete', async () => {
    const source = new InMemoryThemeSource();
    expect(await source.list()).toEqual([]);
    expect(await source.read('mine')).toBeNull();

    const theme = { name: 'Mine', base: 'dark' as const, tokens: { '--accent': '#ff8800' } };
    await source.write('mine', theme);

    expect(await source.read('mine')).toEqual(theme);
    expect(await source.list()).toEqual([theme]);

    await source.delete('mine');
    expect(await source.read('mine')).toBeNull();
    expect(await source.list()).toEqual([]);
  });
});
