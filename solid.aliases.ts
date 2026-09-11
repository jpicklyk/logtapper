import { fileURLToPath } from "node:url";

/**
 * The single source of truth for the Solid frontend's path aliases.
 *
 * `vite.solid.config.ts` and `vitest.solid.config.ts` both import this — the
 * vitest config cannot cleanly extend the vite one (it needs `solid({ hot:
 * false })`), so before this module the map was copy-pasted between them and
 * drifting was only a matter of time.
 *
 * `tsconfig.solid.json`'s `paths` is a third copy that cannot be shared (JSON,
 * different syntax). `src-solid/aliases.test.ts` asserts the two agree.
 */
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Absolute repo root (the directory this file lives in), independent of cwd. */
export const solidRepoRoot = r("./");

/** alias → repo-relative directory, the form the tsconfig `paths` mirror. */
export const solidAliasPaths: Record<string, string> = {
  "@bridge": "src-next/bridge",
  "@viewport": "src-next/viewport",
  "@cache": "src-next/cache",
  "@events": "src-next/events",
  "@filter": "src-next/filter",
  "@bench": "src-next/bench",
};

/** alias → absolute directory, the form Vite's `resolve.alias` wants. */
export const solidAliases: Record<string, string> = Object.fromEntries(
  Object.entries(solidAliasPaths).map(([key, rel]) => [key, r(`./${rel}`)]),
);
