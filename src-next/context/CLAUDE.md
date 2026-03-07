# src-next/context/ — Split Context System

## Architecture

Five contexts split by change frequency (principle #1):

| Context | Change frequency |
|---|---|
| `SessionContext` | Low (session load/close) |
| `ViewerContext` | Medium (search, navigation) — internally split into 3 sub-contexts |
| `PipelineContext` | Mixed (processors stable, results fast) |
| `TrackerContext` | Fast (~50ms during streaming) |
| `ActionsContext` | Never (stable callbacks) |

### ViewerContext sub-context split

`ViewerContext.tsx` contains 3 internal sub-contexts to isolate re-renders by change frequency:

| Sub-context | State | Frequency | Selector hooks |
|---|---|---|---|
| `SearchCtx` | `search`, `searchSummary`, `currentMatchIndex` | medium-high | `useSearch()`, `useSearchQuery()` |
| `ScrollCtx` | `scrollToLine`, `jumpSeq`, `jumpPaneId` | medium | `useScrollTarget()` |
| `ProcessorViewCtx` | `processorId` | low | `useProcessorId()` |

`ViewerProvider` nests all 3 providers and owns all `useState` calls. The narrow hooks (`useSearchCtx`, `useScrollCtx`, `useProcessorViewCtx`) are used by `selectors.ts` so each selector subscribes to only its relevant sub-context.

`useViewerContext()` is a facade that reads all 3 sub-contexts — used by writer hooks (`useLogViewer`, `useSearchNavigation`, `useSessionTabManager`) that need setter access across all viewer state.

## Public API (exported from barrel `index.tsx`)

The barrel exports selector hooks (e.g. `useSession()`, `useIsStreaming()`, `usePipelineResults()`, `useTrackerTransitions()`) and `AppProviders`. See `index.tsx` for the full list.

**Internal (NOT in barrel):** raw context hooks like `useSessionContext()`, `useViewerContext()`, `useSearchCtx()`, `useScrollCtx()`, `useProcessorViewCtx()` are internal — only domain hooks and selectors import these directly from context files.

Domain hooks (`useLogViewer`, `usePipeline`, `useStateTracker`) are co-owners of context state and need setter access.

## Adding a new selector

1. Add the hook to `selectors.ts`, reading from the appropriate narrow context
2. Re-export from the barrel (`index.tsx`)
3. Components import from the barrel: `import { useMySelector } from '../../context'`

## ActionsContext pattern

Default stubs (no-op functions) are defined in `ActionsContext.tsx`. `HookWiring` (in `index.tsx`) instantiates domain hooks and injects real implementations via `ActionsProvider`. This ensures components always have a valid actions reference, even during initialization.
