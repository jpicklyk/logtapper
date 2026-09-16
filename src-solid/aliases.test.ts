import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { solidAliasPaths, solidAliases, solidBarrelAliases, solidRepoRoot } from '../solid.aliases';

/**
 * The frontend declares its aliases three times: `solid.aliases.ts` (which
 * vite.config.ts and vitest.config.ts both import) and the `paths` block of
 * tsconfig.json, which cannot import anything. This pins the two together — a
 * new alias in one and not the other fails here, not at runtime.
 *
 * The barrel-only subset is declared a fourth time, as a regex alternation in
 * `eslint.config.js` (a flat config this file cannot import into a vitest
 * run without loading the whole plugin graph), so that list is pinned here by
 * reading the file.
 */

// Resolve from the alias module's own location, not cwd — vitest may be
// invoked with `--root` from another checkout (worktree runs).
const repoRoot = solidRepoRoot;

function readTsconfigPaths(): Record<string, string[]> {
  const raw = readFileSync(resolve(repoRoot, 'tsconfig.json'), 'utf8');
  // tsconfig is JSONC; only line comments are used in this file.
  const stripped = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return (JSON.parse(stripped) as { compilerOptions: { paths: Record<string, string[]> } })
    .compilerOptions.paths;
}

describe('solid alias map', () => {
  const paths = readTsconfigPaths();
  const wildcardKeys = Object.keys(paths).filter((k) => k.endsWith('/*'));
  const bareKeys = Object.keys(paths).filter((k) => !k.endsWith('/*'));

  it('declares one wildcard tsconfig path per alias, and no extras', () => {
    expect(wildcardKeys.sort()).toEqual(Object.keys(solidAliasPaths).map((k) => `${k}/*`).sort());
  });

  it.each(Object.entries(solidAliasPaths))('maps %s to the same directory as tsconfig', (key, rel) => {
    expect(paths[`${key}/*`]).toEqual([`${rel}/*`]);
  });

  it('only declares bare tsconfig paths for known aliases, pointing at that alias', () => {
    for (const key of bareKeys) {
      const rel = solidAliasPaths[key];
      expect(rel, `bare path "${key}" is not a declared alias`).toBeDefined();
      expect(paths[key]).toEqual([`${rel}/index.ts`]);
    }
  });

  it('resolves every alias to a directory that exists', () => {
    for (const [key, abs] of Object.entries(solidAliases)) {
      expect(existsSync(abs), `${key} → ${abs}`).toBe(true);
      expect(existsSync(resolve(repoRoot, solidAliasPaths[key]))).toBe(true);
    }
  });
});

describe('barrel-only aliases', () => {
  const paths = readTsconfigPaths();

  it('declares a bare tsconfig path resolving to the barrel, for each', () => {
    for (const key of solidBarrelAliases) {
      const rel = solidAliasPaths[key];
      expect(rel, `${key} is not a declared alias`).toBeDefined();
      expect(paths[key]).toEqual([`${rel}/index.ts`]);
      expect(existsSync(resolve(repoRoot, `${rel}/index.ts`)), `${rel}/index.ts`).toBe(true);
    }
  });

  it('matches the alternation ESLint enforces', () => {
    const config = readFileSync(resolve(repoRoot, 'eslint.config.js'), 'utf8');
    const match = /\^@\(([a-zA-Z|]+)\)\//.exec(config);
    expect(match, 'no barrel-only alternation found in eslint.config.js').not.toBeNull();
    expect(match![1].split('|').map((a) => `@${a}`).sort()).toEqual([...solidBarrelAliases].sort());
  });
});
