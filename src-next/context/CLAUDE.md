# src-next/context/ — Split Context System

## Architecture

Seven contexts split by change frequency (principle #1):

| Context | Change frequency |
|---|---|
| `WorkspaceContext` | Low (save/open/dirty flag) — outermost provider |
| `SessionContext` | Low (session load/close) — internally split into 3 sub-contexts |
| `SessionDataContext` | Per-session (pipeline results, tracker transitions, filter, indexing) — one provider per pane + sidebar |
| `ViewerContext` | Medium (scroll targeting, processor view) — internally split into 2 sub-contexts |
| `PaneSearchContext` | Medium-high (query, match progress) — one provider per pane |
| `PipelineContext` | Mixed (processors stable, results fast) |
| `TrackerContext` | Fast (~50ms during streaming) |
| `ActionsContext` | Never (stable callbacks, mutation tracking) |

### ViewerContext sub-context split

`ViewerContext.tsx` contains 2 internal sub-contexts to isolate re-renders by change frequency:

| Sub-context | State | Frequency | Selector hooks |
|---|---|---|---|
| `ScrollCtx` | `scrollToLine`, `jumpSeq`, `jumpPaneId` | medium | `useScrollTarget()` |
| `ProcessorViewCtx` | `processorId` | low | `useProcessorId()` |

`ViewerProvider` nests both providers and owns all `useState` calls. The narrow hooks (`useScrollCtx`, `useProcessorViewCtx`) are used by `selectors.ts` so each selector subscribes to only its relevant sub-context.

`useViewerContext()` is a facade that reads both sub-contexts — used by writer hooks (`useLogViewer`, `useSearchNavigation`, `useSessionTabManager`) that need setter access across all viewer state.

**Search is not in ViewerContext.** A third `SearchCtx` sub-context held `search` / `searchSummary` / `currentMatchIndex` until search went per-pane. Afterwards every setter still had callers (`useSearchNavigation`, `useSessionTabManager`, `useLogViewer`) but no component read the state, so a whole second search execution path — its own `search-progress` subscription and its own accumulate/jump-to-first-match loop — ran on every query and rendered nothing. It was removed along with the `setSearch` / `jumpToMatch` / `setEffectiveLineNums` view actions that fed it. Search state, its backend call, and match navigation live only in `PaneSearchContext` (`usePaneSearch`, `usePaneSearchQuery`, `usePaneSearchActions`); it scrolls through the still-global `jumpToLine(lineNum, paneId)`.

### SessionDataContext — per-session isolation

`SessionDataContext.tsx` provides per-session data in isolation. One `SessionDataProvider` is mounted per center pane (in `PaneContent`) and per sidebar pane (in `LeftPane`, `RightPane`, `BottomPane`). Each provider extracts its session's slice from the global Maps in PipelineContext, TrackerContext, and SessionContext.

**Key benefit:** A pipeline run completing for Session A only re-renders Session A's provider tree. Components showing Session B are unaffected.

**Center panes** use the pane's own session (via `useSessionForPane`). **Sidebar panes** use the focused session (via `useFocusedSession`).

**Selector hooks (read from nearest SessionDataProvider):**
- `useSessionPipelineResults()`, `useSessionPipelineRunning()`, `useSessionPipelineProgress()`, `useSessionPipelineError()`
- `useSessionTrackerTransitions()`, `useSessionTrackerUpdateCounts()`
- `useSessionFilterState()`, `useSessionIndexingProgress()`
- `useSessionDataId()` — the provider's sessionId

**When adding new per-session state:** Add it to `SessionDataContextValue` and create a selector hook. Components inside a `SessionDataProvider` can read it directly — no need to pass sessionId.

**Global Maps remain as write targets:** Domain hooks (`usePipelineWiring`/`usePipelineCommands`, `useStateTracker`, `useFilterScan`) write per-session data to global Maps in PipelineContext, TrackerContext, and SessionContext. `SessionDataProvider` reads from these Maps and provides isolated slices. The old global per-session selectors (`usePipelineResults`, `useTrackerTransitions`, etc.) have been removed — all per-session reads go through `SessionDataContext` hooks.

### SessionActionsContext — per-session mutation surface

`SessionActionsContext.tsx` provides mutation callbacks scoped to one session. Mounted alongside `SessionDataProvider` in each pane and sidebar.

**Actions:** `addBookmark`, `editBookmark`, `removeBookmark`, `addWatch`, `removeWatch`

**Selector hooks:** `useSessionBookmarkActions()`, `useSessionWatchActions()`

**Dirty tracking:** Bookmark mutations automatically emit `workspace:mutated` (`markDirty()` + `bus.emit('workspace:mutated', { source: 'artifact' })`, done inline in this file — bookmarks are not part of `ActionsContext`'s tracked registries). Watch mutations do not (transient monitoring, not persisted artifacts).

**Analyses are NOT on this context.** They moved to the workspace-layer action surface (`ActionsContext` → `useAnalysisActions()`) because analyses are workspace-owned artifacts, not per-session state — see the next section.

**SessionId from provider:** Actions read sessionId from a ref pattern — callbacks are stable and never recreated when sessionId changes. Components don't need to pass sessionId.

### SessionContext sub-context split

`SessionContext.tsx` contains 3 internal sub-contexts to isolate re-renders by change frequency:

| Sub-context | State | Callbacks | Frequency | Selector hooks |
|---|---|---|---|---|
| `SessionCoreCtx` | `sessions`, `paneSessionMap`, `loadingPaneIds`, `errorByPane`, `streamingSessionIds` | `registerSession`, `unregisterSession`, `updateSession`, `terminateSession`, `setLoadingPane`, `setErrorPane`, `activateSessionForPane`, `setStreamingSession` | low (session load/close) | `useSessionForPane()`, `useIsLoadingForPane()`, `useIsStreamingForPane()` |
| `SessionPaneCtx` | `activeLogPaneId`, `activePaneId` | (none) | medium (pane focus changes) | `useActiveLogPaneId()`, `useIsActiveLogPane()`, `useActivePaneId()`, `useIsActivePane()` |
| `SessionProgressCtx` | `indexingProgressBySession`, `filterStateBySession` | `setIndexingProgress`, `setSessionFilter`, `resetSessionFilter`, `appendSessionFilterMatches` | medium-high (indexing ticks, filter scans) | `useIndexingProgress()`, `useSetSessionFilter()`, `useStreamFilter()` |

`SessionProvider` nests all 3 providers and owns the single `useReducer`. Each sub-context value is wrapped in its own `useMemo` with only the relevant state fields as dependencies. All action callbacks are `useCallback`-wrapped around `dispatch` (stable ref), so they never trigger re-renders.

`useSessionContext()` is a facade that reads all 3 sub-contexts — used by domain hooks (`useLogViewer`, etc.) and `HookWiring` that need cross-context access. Selectors in `selectors.ts` import the narrow hooks (`useSessionCoreCtx`, `useSessionPaneCtx`, `useSessionProgressCtx`) directly from `SessionContext.tsx`.

## Public API (exported from barrel `index.tsx`)

The barrel exports selector hooks (e.g. `useSession()`, `useIsStreaming()`, `usePipelineResults()`, `useTrackerTransitions()`) and `AppProviders`. See `index.tsx` for the full list.

**Internal (NOT in barrel):** raw context hooks like `useSessionContext()`, `useSessionCoreCtx()`, `useSessionPaneCtx()`, `useSessionProgressCtx()`, `useViewerContext()`, `useSearchCtx()`, `useScrollCtx()`, `useProcessorViewCtx()` are internal — only domain hooks and selectors import these directly from context files.

Domain hooks (`useLogViewer`, `usePipelineWiring`, `usePipelineCommands`, `useStateTracker`) are co-owners of context state and need setter access.

## Adding a new selector

1. Add the hook to `selectors.ts`, reading from the appropriate narrow context
2. Re-export from the barrel (`index.tsx`)
3. Components import from the barrel: `import { useMySelector } from '../../context'`

## WorkspaceContext — workspace identity and dirty tracking

`WorkspaceContext.tsx` holds the workspace identity (`name`, `filePath`, `dirty` flag) and provides `markDirty()`, `markClean()`, `resetIdentity()`. It listens to the `workspace:mutated` bus event for component-local hooks that bypass `ActionsContext`.

**Provider hierarchy:** `WorkspaceProvider` wraps all other providers (outermost). This ensures workspace lifecycle actions (new/open/save) can coordinate across all child contexts.

**Title bar:** A `useEffect` in `WorkspaceProvider` updates the Tauri window title: `{name} — LogTapper` (clean) or `{name} * — LogTapper` (dirty).

**Persistence:** Identity auto-saves to `localStorage` key `logtapper_workspace_identity` for crash recovery. The `.lts` file is the explicit user-controlled persistence.

## ActionsContext — workspace action surface with mutation tracking

`ActionsContext.tsx` defines two action categories:

| Category | Interface | Tracked? | Examples |
|---|---|---|---|
| **WorkspaceMutationActions** | `WorkspaceMutationActions` | Yes — auto-wrapped by `trackMutations()` | `loadFile`, `closeSession`, `addToChain`, `reorderChain` |
| **ViewActions** | `ViewActions` | No — pass through unchanged | `jumpToLine`, `setStreamFilter`, `runPipeline`, `openTab` |

**Enforcement mechanism:** `MUTATION_ACTION_KEYS` is the single registry of workspace-tracked actions. `trackMutations()` wraps each registered key so it fires **both** halves of the dirty signal: `markDirty()` (WorkspaceContext flag → title bar asterisk, workspace-switcher dot) and `bus.emit('workspace:mutated', { source: 'workspace' })` (schedules the debounced auto-save — full `.ltw` write). Applied once in `HookWiring` — the single wiring point. No scattered `bus.emit('workspace:mutated')` needed for actions that flow through here.

**Two registries, two `workspace:mutated` sources.** `trackMutations()` also wraps a second registry, `ARTIFACT_MUTATION_ACTION_KEYS` (`publishAnalysis`, `updateAnalysis`, `deleteAnalysis`), with `markDirty()` + `bus.emit('workspace:mutated', { source: 'artifact' })`. The two registries **must stay disjoint** (asserted by a test in `ActionsContext.test.ts`) — a key in both would double-emit for one action.

Why the split exists: the backend's `schedule_autosave` (`artifact_mutations.rs`) already writes the `.ltw` on every artifact mutation (bookmark or analysis, including MCP-bridge-originated ones), so the frontend must not duplicate that write for analyses. `useWorkspaceAutoSave` branches on `source` — `'workspace'` runs the full `performAutoSave`; `'artifact'` only pushes a refreshed envelope (`sync_workspace_envelope`, no file write) so the backend's already-scheduled write picks up current layout/tabs/chain. See "Backend-originated mutations" below for the full picture, including why bookmarks (still on `SessionActionsContext`, not `ActionsContext`) emit `source: 'artifact'` by hand rather than through `trackMutations()`.

**Which registry for a new mutation action:** if the backend independently persists the mutation on every call (today: bookmarks, analyses — anything under `artifact_mutations.rs`'s `schedule_autosave`), use `ARTIFACT_MUTATION_ACTION_KEYS`. Everything else — anything whose only persister is the frontend's own debounced `.ltw` write — uses `MUTATION_ACTION_KEYS`.

**Analysis actions (`publishAnalysis`, `updateAnalysis`, `deleteAnalysis`):** declared on `WorkspaceMutationActions`, implemented in `HookWiring`'s `rawActions` (thin wrappers around the `bridge/commands` functions of the same name), and exposed to components via the selector `useAnalysisActions()` (`context/selectors.ts`) — not via `SessionActionsContext`. `publishAnalysis` takes an optional `sessionId` (attribution only, not scoping — analyses are workspace-owned) and emits `bus.emit('analysis:published-local', { artifactId })` on success, same as its pre-migration `SessionActionsContext` home, so the publishing surface can suppress its own "analysis published" toast.

These two used to diverge: `trackMutations` called only `markDirty`, while `useWorkspaceAutoSave` subscribes only to the bus. The result was that opening a file, editing the pipeline chain, or installing a processor marked the workspace dirty and then **never persisted it** — only session-layer mutations reached the auto-saver.

**Restore suppression:** because `loadFile` is a tracked mutation, restoring a workspace would otherwise schedule an auto-save of itself — and if the restore only partially succeeded, overwrite the good `.ltw` with the partial set. Restore paths bracket their work in `workspace:restore-begin` / `workspace:restore-end`; `useWorkspaceAutoSave` holds a reference-counted gate (`hooks/workspace/autoSaveGate.ts`) and drops any pending save on begin. Emit the `end` in a `finally` — a missed end suppresses auto-save for the rest of the session.

**Workspace analyses in restore/teardown:** `restoreWorkspace` (`hooks/workspace/restoreCore.ts`) calls `io.setWorkspaceAnalyses(result.analyses)` once, immediately after `workspace:restore-begin` and before any per-entry `loadFile` call — this replaces the workspace analysis store wholesale so the legacy per-session `restoreWorkspaceSession` merges that follow (backend upserts by artifact id) land on top of the correct base set instead of racing a load. A failure there is caught and pushed onto the returned warnings list rather than aborting the restore — sessions still deserve to come back even if the analysis restore failed. The pure-localStorage fallback path (`useStartupRestore`'s `restoreLocalStorageOnly`) always passes `analyses: []`, which correctly clears the store (there is nothing to restore it from). On the teardown side, `useWorkspace.ts`'s `doClearPanes` — the single common teardown for new/open/switch workspace transitions — calls `setWorkspaceAnalyses([])` right after `beginWorkspaceSwitch()` and before `closeAllSessions()`, inside the switch-suppression window that guards against a backend flush racing an empty write mid-teardown.

**Adding a new mutation action:**
1. Add the method signature to `WorkspaceMutationActions` interface
2. Add the key to `MUTATION_ACTION_KEYS` (frontend-persisted) or `ARTIFACT_MUTATION_ACTION_KEYS` (backend-persisted — see above)
3. Wire the implementation in `HookWiring` (inside `rawActions`)
4. Add to the relevant selector (`usePipelineActions`, `useFileActions`, `useAnalysisActions`, etc.)
5. Dirty tracking is automatic — no additional code needed

Default stubs (no-op functions) ensure components always have valid action references during initialization. `HookWiring` (in `index.tsx`) instantiates domain hooks and injects real implementations via `ActionsProvider`.

**Session-layer hooks:** `useBookmarks` and `useWatchList` are session-scoped and operate below the workspace action surface. They call bridge commands directly; `useBookmarks` emits `bus.emit('workspace:mutated', { source: 'artifact' })` at each mutation point (mirroring `SessionActionsContext`'s bookmark actions — see "Backend-originated mutations" below), `useWatchList` does not (transient). `useAnalysis`-equivalent state no longer exists as a session-layer hook: analyses are workspace-owned and go through `ActionsContext`/`useAnalysisActions()` (`AnalysisProvider` in `AnalysisContext.tsx` holds the read-side workspace store).

**Backend-originated mutations:** `useBookmarks`'s `bookmark-update` listener and `AnalysisProvider`'s `onAnalysisUpdate` listener (`AnalysisContext.tsx`) also emit `workspace:mutated` directly — except for `action: 'restored'`, which is emitted only by restore/teardown paths (`set_workspace_analyses`, the legacy per-session merge), never by the MCP bridge; its data came *from* the `.ltw`, so emitting for it marked every freshly-restored workspace dirty with zero user changes (spuriously showing the title-bar asterisk and switcher dot on a workspace nothing had actually touched). The other listeners emit — for bookmarks, **before** the focused-session guard; `AnalysisProvider` has no per-session guard at all (analyses are workspace-owned, not filtered by focus). An artifact created over the MCP bridge is written straight into `AppState` by the bridge handler — no frontend action runs, so nothing else marks the workspace dirty — and for bookmarks it frequently targets a session that is not focused, so emitting after the guard would miss it.

`workspace:mutated` carries a `{ source: 'artifact' | 'workspace' }` payload (`events/events.ts`) that `useWorkspaceAutoSave` uses to pick what happens after the debounce. Backend durability for artifact mutations is now owned by the backend: `schedule_autosave` (`artifact_mutations.rs`) writes the `.ltw` on every bookmark/analysis mutation, including MCP-bridge-originated ones, hardened by a divergence guard and switch-suppression window. So every artifact-mutation emitter fires with `source: 'artifact'` — `SessionActionsContext`'s bookmark actions, `useBookmarks`'s backend-listener emit, `ActionsContext`'s `ARTIFACT_MUTATION_ACTION_KEYS`-wrapped analysis actions (frontend-driven publish/update/delete), and `AnalysisProvider`'s backend-listener emit (MCP-bridge-driven) — and `useWorkspaceAutoSave` never duplicates a `.ltw` write for any of them, it only pushes a fresh envelope to the backend's cache (`sync_workspace_envelope`) so the backend's write picks up the current layout/tabs. `WorkspaceMutationActions` (via `trackMutations`'s `MUTATION_ACTION_KEYS` half) and other workspace-layer emitters (e.g. editor-tab dirty state in `useCenterTree`) fire with `source: 'workspace'` and keep going through the full debounced `performAutoSave` — the frontend remains their only persister. This is the resolution of work item `59b23f93`, implemented in `ef0bf50c`; the double-emit noted above (a frontend-driven mutation triggering both its own action-surface emit and, once the resulting `*-update` event round-trips, the backend-listener emit) is now harmless — `markDirty` is idempotent and the envelope push is cheap — so it was left as-is rather than restructured.
