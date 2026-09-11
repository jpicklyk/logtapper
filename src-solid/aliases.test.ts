import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { solidAliasPaths, solidAliases, solidRepoRoot } from '../solid.aliases';

/**
 * The Solid frontend declares its aliases three times: `solid.aliases.ts` (which
 * vite.solid.config.ts and vitest.solid.config.ts both import) and the `paths`
 * block of tsconfig.solid.json, which cannot import anything. This pins the two
 * together — a new alias in one and not the other fails here, not at runtime.
 */

// Resolve from the alias module's own location, not cwd — vitest may be
// invoked with `--root` from another checkout (worktree runs).
const repoRoot = solidRepoRoot;

function readTsconfigPaths(): Record<string, string[]> {
  const raw = readFileSync(resolve(repoRoot, 'tsconfig.solid.json'), 'utf8');
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
