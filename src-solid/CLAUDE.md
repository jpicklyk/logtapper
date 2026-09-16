# src-solid/ — The shipped frontend (Solid 1.9)

Every `.tsx` here starts with `/** @jsxImportSource solid-js */` (there is no global
`jsxImportSource` because the shared modules reach React types through barrels). Build
and test with the root scripts: `npm run dev`, `npm run build`, `npm test` (all Solid),
`npx tauri dev` for the app. Never run this dev server and the React one at once.

## Architecture in one screen

- **`App.tsx` composes everything.** It builds each store once (`createSessionStore`,
  `createWorkspaceStore`, `createQueryStore`, `createSectionsStore`, `createAnalyzerStore`,
  `createDeviceStateStore`, `createAnalysesStore`, `createBookmarksStore`,
  `createWatchesStore`, `createLiveStreamStore`, `createPacksStore`, `createPresenceStore`,
  `createSettingsStore`, `createEditorStore`, `createExportStore`), the one
  `createViewerController`, `createSplitView`, `createTier`, and hands them to each other
  as explicit deps. Stores never import each other; they take the slice they need as a
  structural interface (`WorkspaceSessions`, `SessionStore`, …) so tests pass literals.
- **The shell owns placement.** `shell/surfaces.ts` is the map from surface id to region,
  rail or drawer per tier (compact / standard / wide / ultrawide) and mode (postmortem /
  live). A surface is a destination, not a component: `App.tsx` supplies `slots` keyed by
  surface id and `AppShell` decides where they render. Add a surface there, not in a
  component. Bookmarks and the analyses index are *not* surfaces — they render inside
  `workspace-home` because they are workspace content.
- **The viewer controller is the only way to move the viewer.** `viewer/controller.ts`:
  `scrollToLine(sessionId, line, …)`, `setLineSet(sessionId, 'section'|'filter'|'search',
  lines|null)`, `setHighlights`, `revision`, `cursor`. Sections, bookmarks, analyses,
  device state, the timeline strip, search and agent navigation all go through it. Line
  numbers crossing the bridge are backend-absolute; the controller maps them to rendered
  indices at the viewer boundary (`viewer/LogViewer.tsx` `jumpToLine`).
- **Everything is keyed by session id.** Per-session state lives in `Map<sessionId, …>`
  inside each store and is evicted when `sessions.order()` loses the id (the sweep effect
  in `analyzers/analyzerStore.ts` is the pattern). Backend session ids are deterministic
  per path: a reopen lands on the SAME id, so `sessions.replace()` resets the entry, data
  source, cache and controller state explicitly — `add()` alone would keep stale lines.
- **Workspace = sessions + bookmarks + analyses + chain + layout, saved in `.ltw`.**
  `workspace/workspaceStore.ts` owns open/save/switch/restore and autosave; the session
  membership effect marks the workspace mutated on every open/close and adopts an orphan
  open into a fresh workspace when none is active. `layout.json` is read-modify-written
  under the `solid` namespace, never dropping React's keys. Backend-owned mutations (chain,
  bookmarks, analyses) autosave through the backend's cached envelope — every open,
  restore, switch and new pushes it (`pushEnvelope`).

## Rules (each one is a bug we shipped once)

1. **Cancel-safe `listen()`.** Every Tauri event subscription is registered through the
   store's `track()` helper so a dispose that races the `listen()` promise still
   unsubscribes. Never keep a bare `listen()` promise.
2. **No side effects in the render body.** `invoke()`, `listen()`, timers, DOM listeners
   go in `onMount` / `createEffect` with `onCleanup`. A `.then` callback is not a reactive
   scope: read stores there under `untrack()`.
3. **Generation guards for anything async per session.** Use `reactive/`'s
   `createGenerationGuard` / `coalesceMicrotask` rather than a sixth hand-rolled counter.
   A slow fetch against a partial index must not overwrite the complete one.
4. **Barrel imports across modules only** (`../app/index`, never `../app` — a
   case-insensitive filesystem resolves `../app` to `App.tsx` and TS refuses the program).
   Cross-module reach into `src-next` goes only through the aliases in `solid.aliases.ts`
   and the per-file allow-list in `eslint.config.js` Block 4; never a React `.tsx`.
5. **Static styling in the module CSS, tokens only.** Semantic/domain tokens from
   `styles/tokens.css`; a runtime value is a custom property the class consumes
   (`style={{ '--row-accent': … }}`). `theme/noRawColorLiterals.test.ts` fails on a literal
   colour outside a `var(--x, …)` fallback, and `tokens.contrast.test.ts` pins AA for every
   theme, so declare a token in all four `[data-theme]` blocks.
6. **Errors reach the DOM through a rendered channel** (`actions.reportError`,
   `settingsStore.error`, a panel's `role="alert"`), never an unrendered `String(e)` and
   never an unhandled rejection from a click handler.
7. **Overlays and popovers:** `role="dialog"`, focus moves in on open and back on close,
   Escape closes, a visible close control exists, and the element is `position: fixed` at
   `--z-modal` — an `absolute; inset: 0` overlay is clipped to whatever panel it lives in.
8. **A JSX-element prop is a getter.** Reading `props.slot` twice builds the component
   twice; resolve it once with `children(() => props.slot)`.
9. **Security decisions stay in the backend.** The frontend reflects `McpStatus` and the
   agent-access flag; it never decides anonymization or path access.
10. **No formatter.** ESLint is the only style gate; never run prettier here.

## Module map

| Dir | Owns |
|---|---|
| `app/` | session store, app actions (open/close/focus/replace), session-info popover, shortcuts, bench driver |
| `shell/` | `AppShell`, surface map, tiers, mode, rail/drawer, splitter widths, tab strip, split view, window controls |
| `viewer/` | virtualized viewer, controller, cache binding, selection, scroll controls, stream session core |
| `query/` | query store, search runner, filter scan (the `package:/tag:/level:` mini-language via `@filter`) |
| `sections/` | bugreport section tree, device header, File info entry point |
| `analyzers/`, `devicestate/`, `packs/` | chain/run/results, state at cursor + timeline strip, marketplace packs |
| `analyses/`, `bookmarks/`, `watches/` | artifacts; analyses has the reader/editor and the workspace-pane index |
| `stream/`, `presence/` | live capture controls and store, agent presence/activity/consent |
| `editor/` | CodeMirror documents, markdown preview, editor tabs |
| `export/`, `settings/`, `workspace/` | export dialog, settings tabs, workspace store + home + switcher + layout blob |
| `theme/`, `styles/`, `ui/`, `reactive/` | theme controller + contrast tests, tokens/globals, `CallerBadge`, generation guard + microtask coalescing |

## Testing

`npm test` → `vitest.solid.config.ts` (jsdom, `@solidjs/testing-library`). Stores are tested
against injected fake commands/listeners; components are mounted for real against mocked
bridge boundaries — a test that re-implements the unit's logic against a mock, or asserts a
helper cannot call something it structurally cannot call, is rejected in review. Unit
suites have passed while the built app was broken more than once: the phase gate is a
CDP-driven smoke on a production build (`scripts/bench.md` has the launch recipe).
