import { fileURLToPath } from "node:url";

/**
 * The single source of truth for the frontend's path aliases.
 *
 * `vite.config.ts` and `vitest.config.ts` both import this — the vitest config
 * cannot cleanly extend the vite one (it needs `solid({ hot: false })`), so
 * before this module the map was copy-pasted between them and drifting was
 * only a matter of time.
 *
 * `tsconfig.json`'s `paths` is a third copy that cannot be shared (JSON,
 * different syntax). `src-solid/aliases.test.ts` asserts the two agree.
 *
 * Every alias points into `src-shared/` — the framework-free modules the Solid
 * app shares with the backend's generated bindings. There is no longer a
 * second frontend to keep out: the per-file allow-lists that guarded the reach
 * into the old React tree are gone, replaced by module barrels (see
 * `eslint.config.js` and `src-shared/CLAUDE.md`).
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Absolute repo root (the directory this file lives in), independent of cwd. */
export const solidRepoRoot = r("./");

/** alias → repo-relative directory, the form the tsconfig `paths` mirror. */
export const solidAliasPaths: Record<string, string> = {
  // Modules imported by sub-path: `@bridge/types` is the app's IPC type
  // surface and `@bridge/commands` / `@bridge/events` are the two modules
  // tests partial-mock by specifier, so these keep file-level reach.
  "@bridge": "src-shared/bridge",
  "@viewport": "src-shared/viewport",
  "@cache": "src-shared/cache",
  "@filter": "src-shared/filter",
  "@bench": "src-shared/bench",
  // Barrel-only modules: import the alias bare (`from '@workspace'`), never a
  // file inside it. ESLint Block 2 enforces that.
  "@workspace": "src-shared/workspace",
  "@pipeline": "src-shared/pipeline",
  "@fileinfo": "src-shared/fileinfo",
  "@processors": "src-shared/processors",
  "@analysis": "src-shared/analysis",
  "@timeline": "src-shared/timeline",
  "@viewer": "src-shared/viewer",
  "@bookmarks": "src-shared/bookmarks",
};

/** alias → absolute directory, the form Vite's `resolve.alias` wants. */
export const solidAliases: Record<string, string> = Object.fromEntries(
  Object.entries(solidAliasPaths).map(([key, rel]) => [key, r(`./${rel}`)]),
);

/**
 * The aliases whose module barrel is the only legal import path from
 * `src-solid/` — `from '@workspace'`, never `from '@workspace/restorePlan'`.
 *
 * These replaced the per-file allow-list regexes that guarded the old reach
 * into the React tree: the barrel is now the public API (CLAUDE.md principle
 * 9). `eslint.config.js` Block 4 enforces it with one regex, and
 * `src-solid/aliases.test.ts` pins that regex to this list.
 */
export const solidBarrelAliases: readonly string[] = [
  "@workspace",
  "@pipeline",
  "@fileinfo",
  "@processors",
  "@analysis",
  "@timeline",
  "@viewer",
  "@bookmarks",
];
