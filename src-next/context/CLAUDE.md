# src-next/context/ — Split Context System

## Architecture

Five contexts split by change frequency (principle #1):

| Context | Change frequency | Contains |
|---|---|---|
| `SessionContext` | Low (session load/close) | session, isStreaming, loading, error, indexingProgress |
| `ViewerContext` | Medium (search, navigation) | search, searchSummary, currentMatchIndex, scrollToLine, jumpSeq, streamFilter, timeFilter, processorId |
| `PipelineContext` | Mixed (processors stable, results fast) | processors, pipelineChain, activeProcessorIds, running, progress, lastResults, runCount, error |
| `TrackerContext` | Fast (~50ms during streaming) | allTransitionLineNums, transitionsByLine |
| `ActionsContext` | Never (stable callbacks) | loadFile, startStream, stopStream, runPipeline, jumpToLine, setSearch, openTab, ... |

## Public API (exported from barrel `index.tsx`)

### Selector hooks (for components — principle #4)
- `useSession()`, `useIsStreaming()`, `useIsLoading()`, `useSessionError()`
- `useSearch()`, `useScrollTarget()`
- `usePipelineChain()`, `useActiveProcessorIds()`, `usePipelineRunning()`, `usePipelineResults()`, `useProcessors()`
- `useTrackerTransitions()`
- `useViewerActions()`, `usePipelineActions()`, `useTrackerActions()`

### Provider
- `AppProviders` — nested provider tree, wraps entire app below CacheProvider

### Types
- `IndexingProgress`

## Internal (NOT in barrel)

| Export | Why internal |
|---|---|
| `useSessionContext()` | Raw context — only for domain hooks that write to context setters |
| `useViewerContext()` | Same — useLogViewer needs write access |
| `usePipelineContext()` | Same — usePipeline needs write access |
| `useTrackerContext()` | Same — useStateTracker needs write access |
| `useActionsContext()` | Same — HookWiring injects actions |

Domain hooks (`useLogViewer`, `usePipeline`, `useStateTracker`) import these directly from context files — they are co-owners of context state and need setter access.

## Adding a new selector

1. Add the hook to `selectors.ts`, reading from the appropriate narrow context
2. Re-export from the barrel (`index.tsx`)
3. Components import from the barrel: `import { useMySelector } from '../../context'`

## ActionsContext pattern

Default stubs (no-op functions) are defined in `ActionsContext.tsx`. `HookWiring` (in `index.tsx`) instantiates domain hooks and injects real implementations via `ActionsProvider`. This ensures components always have a valid actions reference, even during initialization.
