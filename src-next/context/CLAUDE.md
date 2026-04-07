# src-next/context/ — Split Context System

## Architecture

Seven contexts split by change frequency (principle #1):

| Context | Change frequency |
|---|---|
| `WorkspaceContext` | Low (save/open/dirty flag) — outermost provider |
| `SessionContext` | Low (session load/close) — internally split into 3 sub-contexts |
| `SessionDataContext` | Per-session (pipeline results, tracker transitions, filter, indexing) — one provider per pane + sidebar |
| `ViewerContext` | Medium (search, navigation) — internally split into 3 sub-contexts |
| `PipelineContext` | Mixed (processors stable, results fast) |
| `TrackerContext` | Fast (~50ms during streaming) |
| `ActionsContext` | Never (stable callbacks, mutation tracking) |

### ViewerContext sub-context split

`ViewerContext.tsx` contains 3 internal sub-contexts to isolate re-renders by change frequency:

| Sub-context | State | Frequency | Selector hooks |
|---|---|---|---|
| `SearchCtx` | `search`, `searchSummary`, `currentMatchIndex` | medium-high | `useSearch()`, `useSearchQuery()` |
| `ScrollCtx` | `scrollToLine`, `jumpSeq`, `jumpPaneId` | medium | `useScrollTarget()` |
| `ProcessorViewCtx` | `processorId` | low | `useProcessorId()` |

`ViewerProvider` nests all 3 providers and owns all `useState` calls. The narrow hooks (`useSearchCtx`, `useScrollCtx`, `useProcessorViewCtx`) are used by `selectors.ts` so each selector subscribes to only its relevant sub-context.

`useViewerContext()` is a facade that reads all 3 sub-contexts — used by writer hooks (`useLogViewer`, `useSearchNavigation`, `useSessionTabManager`) that need setter access across all viewer state.

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

Domain hooks (`useLogViewer`, `usePipeline`, `useStateTracker`) are co-owners of context state and need setter access.

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
| **ViewActions** | `ViewActions` | No — pass through unchanged | `jumpToLine`, `setSearch`, `runPipeline`, `openTab` |

**Enforcement mechanism:** `MUTATION_ACTION_KEYS` is the single registry of tracked actions. `trackMutations()` wraps each registered key with `tracked(fn, markDirty)`. Applied once in `HookWiring` — the single wiring point. No scattered `bus.emit('workspace:mutated')` needed for actions that flow through here.

**Adding a new mutation action:**
1. Add the method signature to `WorkspaceMutationActions` interface
2. Add the key to `MUTATION_ACTION_KEYS`
3. Wire the implementation in `HookWiring` (inside `rawActions`)
4. Add to the relevant selector (`usePipelineActions`, `useViewerActions`, etc.)
5. Dirty tracking is automatic — no additional code needed

Default stubs (no-op functions) ensure components always have valid action references during initialization. `HookWiring` (in `index.tsx`) instantiates domain hooks and injects real implementations via `ActionsProvider`.

**Session-layer hooks:** `useBookmarks`, `useAnalysis`, `useWatches` are session-scoped and operate below the workspace action surface. They call bridge commands directly and emit `bus.emit('workspace:mutated')` at each mutation point. This is the correct pattern for their scope — they will migrate to per-session context providers with their own action surface in a future phase.
