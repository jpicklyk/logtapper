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
  // `src-next/components/FileInfoPanel/` is React territory (the whole
  // `components/` tree is off-limits, per eslint.config.js's Block 4). W3's
  // sections navigator reuses exactly three framework-free modules from it —
  // `sectionTree`, `formatters`, `sectionDescriptions` — via the same
  // file-level ESLint allow-list pattern as `@hooks`.
  "@fileinfo": "src-next/components/FileInfoPanel",
  // `src-next/components/` is React territory too. `ProcessorDashboard/utils.ts`
  // is the one framework-free file in it (var-grouping helpers `analyzerStore`
  // re-exports for W4b) — same file-level ESLint allow-list pattern as `@hooks`.
  "@procdash": "src-next/components/ProcessorDashboard",
  // W6's session-attribution helper — the one framework-free file in
  // `AnalysisPanel/` (everything else there is a React component). Same
  // file-level ESLint allow-list pattern as `@hooks`/`@fileinfo`.
  "@analysisPanel": "src-next/components/AnalysisPanel",
  // W6's pending-selection handoff — the one framework-free file in
  // `AnalysisReader/` (everything else there is a React component).
  "@analysisReader": "src-next/components/AnalysisReader",
  // Same pattern again: `StateTimeline/timelineUtils.ts` is the one
  // framework-free file under `src-next/components/StateTimeline/` (pure
  // line/viewport math + a re-export of the timestamp/duration formatters) —
  // W5's device-state timeline strip reuses it verbatim rather than
  // reimplementing the same math. File-level ESLint allow-list, same shape.
  "@statetimeline": "src-next/components/StateTimeline",
  // The viewer's absolute-line ↔ rendered-index mapping. `src-next/components/
  // LogViewer/` is React territory; `scrollMapping.ts` is its one framework-free
  // file (a binary search over the sorted line-set array, unit-tested next to
  // it). The Solid viewer reuses it verbatim rather than shipping a second copy
  // of the same search — same file-level ESLint allow-list pattern as `@hooks`.
  "@logviewer": "src-next/components/LogViewer",
  // W7's markdown export — the one framework-free file in `BookmarkPanel/`
  // (everything else there is a React component). Same file-level ESLint
  // allow-list pattern as `@hooks`/`@analysisPanel`/`@analysisReader`.
  "@bookmarkPanel": "src-next/components/BookmarkPanel",
};

/** alias → absolute directory, the form Vite's `resolve.alias` wants. */
export const solidAliases: Record<string, string> = Object.fromEntries(
  Object.entries(solidAliasPaths).map(([key, rel]) => [key, r(`./${rel}`)]),
);
