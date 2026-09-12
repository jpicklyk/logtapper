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
  // `src-next/hooks/` is React territory and stays off-limits as a directory:
  // ESLint allows through it only an explicit, per-file allow-list of
  // framework-free modules — `useLogViewer/multiSessionImport` plus the pure
  // workspace-persistence helpers W1a shares (`workspace/appStatePayload`,
  // `reconcileWorkspaceList`, `restorePlan`, `artifactPairing`, `startupFile`)
  // and W4a's `pipelineChainStorage` (default-chain localStorage seed, shared
  // with the React app's own key names).
  // Widening that allow-list needs the same scrutiny as adding an alias.
  "@hooks": "src-next/hooks",
  // `src-next/components/` is React territory too. `ProcessorDashboard/utils.ts`
  // is the one framework-free file in it (var-grouping helpers `analyzerStore`
  // re-exports for W4b) — same file-level ESLint allow-list pattern as `@hooks`.
  "@procdash": "src-next/components/ProcessorDashboard",
};

/** alias → absolute directory, the form Vite's `resolve.alias` wants. */
export const solidAliases: Record<string, string> = Object.fromEntries(
  Object.entries(solidAliasPaths).map(([key, rel]) => [key, r(`./${rel}`)]),
);
