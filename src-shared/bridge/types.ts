// Types that mirror the Rust serde structs crossing the Tauri IPC boundary.
//
// Most types below are re-exported from `./generated` — ts-rs bindings produced by
// `npm run gen:types` (see `src-tauri/tests/export_bindings.rs`). This file stays the
// import surface for the ~127 files that import from it; only types with no backing
// Rust struct, or whose Rust representation (`String`, `serde_json::Value`) ts-rs
// cannot narrow, are hand-written below — each such case carries a one-line comment
// explaining why. See `src-shared/bridge/CLAUDE.md` for the full generated-types flow.

import type * as Generated from './generated';

// ---------------------------------------------------------------------------
// Straight re-exports — identical shape to the generated type, same name.
// Imported (not just re-exported) so the narrowing/local types below this
// block can reference them unqualified too.
// ---------------------------------------------------------------------------

import type {
  LogLevel,
  CreatedBy,
  CombineMode,
  ViewMode,
  HighlightKind,
  AdbStreamEvent,
  AdbDevice,
  AdbExcludedProcessor,
  AdbProcessorsExcluded,
  AdbProcessorUpdate,
  AdbStreamStopped,
  AdbTrackerUpdate,
  AnalysisArtifact,
  AnalysisSection,
  AnonymizerConfig,
  AnonymizerTestResult,
  AppStateFile,
  Bookmark,
  CorrelationEvent,
  CorrelatorResult,
  DumpstateMetadata,
  ExportAllSessionsInfo,
  ExportSessionEntry,
  FieldChange,
  FileAssocEntry,
  FileIndexComplete,
  FileIndexProgress,
  FilterCreateResult,
  FilterCriteria,
  FilterProgress,
  ActivityEntry,
  AgentRequestEvent,
  AgentRequestKind,
  AgentRequestPhase,
  Caller,
  ChainState,
  ChainUpdateEvent,
  PipelineCompleteEvent,
  HighlightSpan,
  LinePage,
  LineRequest,
  LineStats,
  LineStrategy,
  LoadWorkspaceSessionData,
  LtwEditorTab,
  LtwManifestSession,
  LtwPipelineChain,
  MarketplaceFetchResult,
  McpBundleInfo,
  McpHttpInfo,
  McpAgentAccess,
  McpOpenAllowlist,
  McpStatus,
  PackSummary,
  PackUpdateAvailable,
  PatternEntry,
  PiiReplacement,
  PipelineProgress,
  PipelineRunResult,
  PipelineRunSummary,
  RestoreSessionOptions,
  SearchProgress,
  SearchQuery,
  SearchSummary,
  SectionInfo,
  SessionClosedEvent,
  SessionMetadata,
  SkipReason,
  SourceError,
  SourceReference,
  StateSnapshot,
  StateTransition,
  SyncWorkspaceEnvelopeOptions,
  TagCount,
  TimelinePoint,
  TimelineSeriesData,
  UpdateAvailable,
  UpdateCheckResult,
  UpdatesAvailableEvent,
  UpdateResult,
  ViewLine,
  WatchInfo,
  WatchMatchEvent,
  WorkspaceAutoSavedEvent,
  WorkspaceEntry,
  FocusContext,
  FocusContextInput,
  LineRange,
  NavRequest,
  NavRequestInput,
  UserTheme,
  ThemeBase,
  ThemeSummary,
  RenameWorkspaceRequest,
  DeleteWorkspaceRequest,
} from './generated';

export type {
  LogLevel,
  CreatedBy,
  CombineMode,
  ViewMode,
  HighlightKind,
  AdbStreamEvent,
  AdbDevice,
  AdbExcludedProcessor,
  AdbProcessorsExcluded,
  AdbProcessorUpdate,
  AdbStreamStopped,
  AdbTrackerUpdate,
  AnalysisArtifact,
  AnalysisSection,
  AnonymizerConfig,
  AnonymizerTestResult,
  AppStateFile,
  Bookmark,
  CorrelationEvent,
  CorrelatorResult,
  DumpstateMetadata,
  ExportAllSessionsInfo,
  ExportSessionEntry,
  FieldChange,
  FileAssocEntry,
  FileIndexComplete,
  FileIndexProgress,
  FilterCreateResult,
  FilterCriteria,
  FilterProgress,
  ActivityEntry,
  AgentRequestEvent,
  AgentRequestKind,
  AgentRequestPhase,
  Caller,
  ChainState,
  ChainUpdateEvent,
  PipelineCompleteEvent,
  HighlightSpan,
  LinePage,
  LineRequest,
  LineStats,
  LineStrategy,
  LoadWorkspaceSessionData,
  LtwEditorTab,
  LtwManifestSession,
  LtwPipelineChain,
  MarketplaceFetchResult,
  McpBundleInfo,
  McpHttpInfo,
  McpAgentAccess,
  McpOpenAllowlist,
  McpStatus,
  PackSummary,
  PackUpdateAvailable,
  PatternEntry,
  PiiReplacement,
  PipelineProgress,
  PipelineRunResult,
  PipelineRunSummary,
  RestoreSessionOptions,
  SearchProgress,
  SearchQuery,
  SearchSummary,
  SectionInfo,
  SessionClosedEvent,
  SessionMetadata,
  SkipReason,
  SourceError,
  SourceReference,
  StateSnapshot,
  StateTransition,
  SyncWorkspaceEnvelopeOptions,
  TagCount,
  TimelinePoint,
  TimelineSeriesData,
  UpdateAvailable,
  UpdateCheckResult,
  UpdatesAvailableEvent,
  UpdateResult,
  ViewLine,
  WatchInfo,
  WatchMatchEvent,
  WorkspaceAutoSavedEvent,
  WorkspaceEntry,
  FocusContext,
  FocusContextInput,
  LineRange,
  NavRequest,
  NavRequestInput,
  UserTheme,
  ThemeBase,
  ThemeSummary,
  RenameWorkspaceRequest,
  DeleteWorkspaceRequest,
};

// ---------------------------------------------------------------------------
// Renamed re-exports — structurally identical to the generated type, but kept
// under their historical local name (call sites unchanged). Imported under the
// local alias so the rest of this file can reference them unqualified too.
// ---------------------------------------------------------------------------

import type {
  /** `core::analysis::Severity` — renamed to avoid ambiguity with other severities. */
  Severity as AnalysisSeverity,
  /** `SourceReference::highlight_type`'s enum — renamed to avoid ambiguity with `HighlightKind`. */
  HighlightType as HighlightTypeAnnotation,
  /** Correlator ring-buffer match record — renamed to a shorter local alias. */
  SourceMatchRecord as SourceMatch,
  /** Matched-line summary from `get_matched_lines` — renamed to a shorter local alias. */
  MatchedLineInfo as MatchedLine,
  /** ADB streaming batch — renamed to `*Payload` to match the other Channel/event payload names. */
  AdbBatch as AdbBatchPayload,
  /** `.ltw` v4 load result — renamed to keep the historical `V4` local name. */
  LoadWorkspaceResult as LoadWorkspaceV4Result,
  /** `save_workspace_v4` options — renamed to keep the historical `V4` local name. */
  SaveWorkspaceOptions as SaveWorkspaceV4Options,
  /** Marketplace processor index entry (camelCase DTO) — renamed to drop the `Dto` suffix locally. */
  MarketplaceEntryDto as MarketplaceEntry,
  /**
   * Marketplace pack index entry (camelCase DTO, as returned by `fetch_marketplace_for_source`)
   * — renamed to drop the `Dto` suffix locally. Distinct from the generated `MarketplacePackEntry`
   * (snake_case `processor_ids`, the `install_pack_from_marketplace` argument shape) — do not
   * collapse the two; `commands.ts` declares that argument shape inline.
   */
  MarketplacePackEntryDto as MarketplacePackEntry,
} from './generated';

export type {
  AnalysisSeverity,
  HighlightTypeAnnotation,
  SourceMatch,
  MatchedLine,
  AdbBatchPayload,
  LoadWorkspaceV4Result,
  SaveWorkspaceV4Options,
  MarketplaceEntry,
  MarketplacePackEntry,
};

// ---------------------------------------------------------------------------
// Narrowed re-exports — the Rust field is a plain `String` (or `Option<String>`),
// so ts-rs cannot narrow it to a literal union. Each hand-written narrowing below
// reflects the values the Rust source actually emits today. These are candidates
// to become real Rust enums (derive `TS` on the enum instead of overriding here) —
// once that happens the override can be deleted.
// ---------------------------------------------------------------------------

/** Rust `action` field is a `String`; only these four values are ever emitted. */
export type AnalysisUpdateEvent = Omit<Generated.AnalysisUpdateEvent, 'action'> & {
  action: 'published' | 'updated' | 'deleted' | 'restored';
};

/** Rust `action` field is a `String`; only these three values are ever emitted. */
export type BookmarkUpdateEvent = Omit<Generated.BookmarkUpdateEvent, 'action'> & {
  action: 'created' | 'updated' | 'deleted';
};

/** Rust `action` field is a `String`; only these three values are ever emitted
 *  (`services::processors::emit_catalog_update`). */
export type CatalogUpdateEvent = Omit<Generated.CatalogUpdateEvent, 'action'> & {
  action: 'install' | 'uninstall' | 'update';
};

/** Rust `status` field is a `String`; only these three values are ever emitted. */
export type FilterInfo = Omit<Generated.FilterInfo, 'status'> & {
  status: 'scanning' | 'complete' | 'cancelled';
};

/** Rust `status` field is a `String`; only these three values are ever emitted. */
export type FilteredLinesResult = Omit<Generated.FilteredLinesResult, 'status'> & {
  status: 'scanning' | 'complete' | 'cancelled';
};

/**
 * Rust `processorType` field is a `String`; only these four values are ever emitted.
 * `varsMeta: VarMeta[]` is still `Generated.VarMeta` underneath (its `displayAs` is
 * widened to `string | null`, not the narrowed `VarMeta` below) — narrowing does not
 * thread through nested generated types.
 */
export type ProcessorSummary = Omit<Generated.ProcessorSummary, 'processorType'> & {
  processorType: 'transformer' | 'reporter' | 'state_tracker' | 'correlator';
};

/** Rust `action` field is a `String`; only these two values are ever emitted. */
export type WatchUpdateEvent = Omit<Generated.WatchUpdateEvent, 'action'> & {
  action: 'created' | 'cancelled';
};

/** Rust `source` field is a `String`; only these two values are ever emitted —
 *  `"lts"` for a `.lts` bundle import, `"workspace"` for a `.ltw` restore. */
export type WorkspaceRestoredEvent = Omit<Generated.WorkspaceRestoredEvent, 'source'> & {
  source: 'lts' | 'workspace';
};

/** Rust `action` field is a `String`; only these two values are ever emitted. */
export type WorkspaceListChangedEvent = Omit<Generated.WorkspaceListChangedEvent, 'action'> & {
  action: 'renamed' | 'deleted';
};

/** Rust `tier` field is a `String`; only these three values are ever emitted. */
export type DetectorEntry = Omit<Generated.DetectorEntry, 'tier'> & {
  tier: 'tier1' | 'tier2' | 'tier3';
};

/**
 * Rust `viewMode` field on `LtsEditorTab` (the `.lts` zip's `editor-tabs.json` shape)
 * is a `String`; only these three values are ever written/read. Renamed locally to
 * `LtsEditorTabPayload` to avoid colliding with the unrelated `.ltw` `LtwEditorTab`
 * (also `viewMode: string`, kept untouched as a straight re-export above).
 */
export type LtsEditorTabPayload = Omit<Generated.LtsEditorTab, 'viewMode'> & {
  viewMode: 'editor' | 'split' | 'preview';
};

/** Rust `displayAs` field is `Option<String>`; only these two values are ever emitted. */
export type VarMeta = Omit<Generated.VarMeta, 'displayAs'> & {
  displayAs: 'table' | 'value' | null;
};

// ---------------------------------------------------------------------------
// Local extensions — the generated type is correct but incomplete for a
// client-side-only field with no Rust counterpart.
// ---------------------------------------------------------------------------

/**
 * `lostLineCount` is client-side only: cumulative count of live-stream lines
 * permanently lost because they could not be spilled to disk. Never sent by the
 * backend at load time (a fresh session has none); populated from
 * `AdbBatchPayload` via `updateSession` as the stream runs. Undefined for file
 * sessions. The Rust `LoadResult` struct does not have this field.
 */
export type LoadResult = Generated.LoadResult & { lostLineCount?: number };

// ---------------------------------------------------------------------------
// Hand-written — no generated twin, or deliberately divergent from the Rust type.
// ---------------------------------------------------------------------------

/**
 * Mirrors the Rust `SourceType` enum in `src-tauri/src/core/session.rs` — that
 * enum is the source of truth. `Radio` is reachable from content detection;
 * `Events`, `Tombstone` and `ANRTrace` exist on the backend and can arrive over
 * IPC. `Custom { parser_id }` serializes as `Custom(<id>)` and is intentionally
 * not enumerated here.
 *
 * `core::session::SourceType` is NOT derived with `TS` (every IPC field that
 * carries it — `LoadResult.sourceType`, `SessionMetadata.sourceType`,
 * `LtwManifestSession.sourceType` — is already a plain Rust `String`), so this
 * stays hand-written and deliberately divergent (it's a strict frontend-side
 * narrowing plus the `'Unknown'` fallback below).
 *
 * `'Unknown'` is NOT a backend variant — it is a frontend-only fallback used
 * when a session's type cannot be resolved locally (see `useSessionTabManager`).
 */
export type SourceType =
  | 'Bugreport'
  | 'Dumpstate'
  | 'Logcat'
  | 'Kernel'
  | 'Radio'
  | 'Events'
  | 'Tombstone'
  | 'ANRTrace'
  | 'Unknown';

/** Dumpstate is a superset of Bugreport (Samsung dumps). Both need identical UI treatment. */
export function isBugreportLike(t: SourceType | string): boolean {
  return t === 'Bugreport' || t === 'Dumpstate';
}

/**
 * The `LinePage` to hand a caller when there is nothing to fetch — no session
 * bound to the pane yet, or one that closed mid-scroll. Shaped like a real
 * empty answer at `offset` rather than a sentinel, so consumers need no
 * null branch. `sessionId` is empty because there is no session to name.
 */
export function emptyPage(offset = 0): LinePage {
  return { sessionId: '', totalLines: 0, offset, count: 0, truncated: false, lines: [] };
}

/**
 * HAND-WRITTEN, deliberately NOT switched to `Generated.Source` yet — tracked bug
 * `ee4ddb0b`. The Rust `processors::marketplace::Source` has no
 * `#[serde(rename_all = "camelCase")]`, so its real wire shape is snake_case
 * (`auto_update`, `last_checked`) and its `type` field is the internally-tagged
 * union `{type:'github', repo, git_ref} | {type:'local', path}` — not the flat
 * `repo?/ref?/path?` shape below, and `ref` should be `git_ref`. This mismatch is
 * a live defect (today `autoUpdate` silently drops to `false` on the wire and
 * `lastChecked` never round-trips), fixed by WP-9 on the Rust side. Do not
 * switch this to the generated type until that lands, or `addSource` breaks.
 */
export interface Source {
  name: string;
  type: 'github' | 'local';
  repo?: string;
  ref?: string;
  path?: string;
  enabled: boolean;
  autoUpdate: boolean;
  lastChecked?: string;
}

// ---------------------------------------------------------------------------
// Processor authoring / UI-only types — no Rust struct backs these; they exist
// only to shape data the UI builds or groups locally.
// ---------------------------------------------------------------------------

/** UI-only: registry browsing metadata for `fetchRegistry` — a legacy Phase 4 list
 *  item shape, not currently backed by an IPC struct beyond `RegistryEntry` itself. */
export interface ProcessorMeta {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
}

/** UI-only: the set of var kinds the processor-authoring editor can declare. No Rust struct — a
 *  Rhai `VarDecl` is untyped YAML on the backend; this union exists only to drive the editor form. */
export type VarType = 'int' | 'bool' | 'string' | 'float' | 'map' | 'list';

/** UI-only: a var declaration as edited in the processor-authoring form, before it is
 *  serialized to YAML. Not an IPC type — see `VarType` above. */
export interface VarDecl {
  name: string;
  type: VarType;
  default: unknown;
  display: boolean;
  label: string;
  displayAs?: 'table' | 'value';
  columns?: string[];
  configurable?: boolean;
}

// ---------------------------------------------------------------------------
// Registry types (Phase 4)
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  path: string;
  tags: string[];
  sha256: string;
}

// ---------------------------------------------------------------------------
// Marketplace source types (Phase 2 — Source Management)
// ---------------------------------------------------------------------------

/** Build a qualified processor ID matching the backend convention: `id@source` */
export function makeQualifiedId(id: string, source: string): string {
  return `${id}@${source}`;
}

/** Extract bare ID from a potentially qualified ID (strip `@source` suffix). */
export function getBareId(qualifiedId: string): string {
  const at = qualifiedId.lastIndexOf('@');
  return at > 0 ? qualifiedId.substring(0, at) : qualifiedId;
}

/**
 * Resolve pipeline chain IDs to their ProcessorSummary objects via a Map
 * lookup, preserving chain order. IDs that don't resolve (e.g. a processor
 * referenced by a persisted chain but no longer installed) are dropped.
 */
export function resolveChainProcessors(
  chainIds: string[],
  processors: ProcessorSummary[],
): ProcessorSummary[] {
  const byId = new Map(processors.map((p) => [p.id, p]));
  const resolved: ProcessorSummary[] = [];
  for (const id of chainIds) {
    const p = byId.get(id);
    if (p) resolved.push(p);
  }
  return resolved;
}

/** UI-only: no Rust struct — groups an already-resolved processor list by owning pack for rendering. */
export interface ProcessorPackGroup {
  pack: PackSummary;
  processors: ProcessorSummary[];
}

/**
 * Group a list of processors (already resolved/ordered, e.g. via
 * `resolveChainProcessors`) into their owning packs, plus a standalone
 * bucket for processors that don't belong to any installed pack.
 *
 * Pack manifests reference bare IDs ("wifi-state") while processors carry
 * qualified IDs ("wifi-state@official"), so matching goes through
 * `getBareId`. Within each pack, processors are emitted in `chainProcessors`
 * order (not `pack.processorIds` order) — this preserves whatever order the
 * caller resolved the chain in, which matters when the chain is user-
 * reorderable (e.g. ProcessorPanel's drag-and-drop).
 */
export function groupProcessorsByPack(
  chainProcessors: ProcessorSummary[],
  packs: PackSummary[],
): { packGroups: ProcessorPackGroup[]; standaloneProcessors: ProcessorSummary[] } {
  const groups: ProcessorPackGroup[] = [];
  const assigned = new Set<string>();

  for (const pack of packs) {
    const packBareIds = new Set(pack.processorIds);
    const packProcs = chainProcessors.filter((p) => packBareIds.has(getBareId(p.id)));
    if (packProcs.length > 0) {
      groups.push({ pack, processors: packProcs });
      for (const p of packProcs) assigned.add(p.id);
    }
  }

  const standalone = chainProcessors.filter((p) => !assigned.has(p.id));
  return { packGroups: groups, standaloneProcessors: standalone };
}

/** Check if all active filter tags are present in the item's tags. */
export function matchesAllTags(tags: string[], activeFilters: Set<string>): boolean {
  for (const tag of activeFilters) {
    if (!tags.includes(tag)) return false;
  }
  return true;
}

/**
 * Case-insensitive match against an item's name, description, and tags.
 * `q` must already be lowercased — callers typically compute it once per
 * query rather than re-lowercasing per item.
 */
export function matchesQuery(
  item: { name: string; description?: string | null; tags: string[] },
  q: string,
): boolean {
  return (
    item.name.toLowerCase().includes(q) ||
    (item.description ?? '').toLowerCase().includes(q) ||
    item.tags.some((t) => t.toLowerCase().includes(q))
  );
}

/** Filter marketplace entries by search query (matches name, description, tags) */
export function filterMarketplaceEntries(entries: MarketplaceEntry[], query: string): MarketplaceEntry[] {
  if (!query) return entries;
  const q = query.toLowerCase();
  return entries.filter((e) => matchesQuery(e, q));
}

// ---------------------------------------------------------------------------
// Filter types (Phase 1)
// ---------------------------------------------------------------------------

/** Short single-letter labels for LogLevel, used in compact chip/text displays. */
export const LEVEL_SHORT: Record<string, string> = {
  Verbose: 'V',
  Debug: 'D',
  Info: 'I',
  Warn: 'W',
  Error: 'E',
  Fatal: 'F',
};

/**
 * Ordered list of human-readable parts describing a FilterCriteria (text
 * search, regex, levels, tags, pids). Consumers decide how to turn the array
 * into UI — e.g. join into a single string for a toast message. Doesn't cover
 * `combine` — callers that need to call out OR-mode (e.g. CriteriaChips'
 * accent chip) render that separately.
 */
export function describeCriteriaParts(criteria: FilterCriteria): string[] {
  const parts: string[] = [];
  if (criteria.textSearch) parts.push(`text:${criteria.textSearch}`);
  if (criteria.regex) parts.push(`/${criteria.regex}/`);
  if (criteria.logLevels?.length) {
    parts.push(criteria.logLevels.map((l) => LEVEL_SHORT[l] ?? l).join(','));
  }
  if (criteria.tags?.length) parts.push(`tag:${criteria.tags.join(',')}`);
  if (criteria.pids?.length) parts.push(`pid:${criteria.pids.join(',')}`);
  return parts;
}

// ---------------------------------------------------------------------------
// Bookmark types (Phase 2)
// ---------------------------------------------------------------------------

/** UI-only: no Rust struct — a fixed local vocabulary for bookmark category chips.
 *  The wire field (`Bookmark.category`) is a plain `string`. */
export type BookmarkCategory = 'error' | 'warning' | 'state-change' | 'timing' | 'observation' | 'custom';

/** Renders a severity as a CSS color token. */
export function severityColor(severity: AnalysisSeverity | null): string {
  switch (severity) {
    case 'Critical': return 'var(--danger)';
    case 'Error':    return 'var(--danger)';
    case 'Warning':  return 'var(--warning)';
    case 'Info':     return 'var(--accent)';
    default:         return 'var(--text-dimmed)';
  }
}

// ---------------------------------------------------------------------------
// Export types (T4 + T5) — hand-written: nested `editorTabs` needs the narrowed
// `LtsEditorTabPayload.viewMode` union above; `Generated.ExportAllOptions` widens
// it to `string` (narrowing doesn't thread through nested generated types).
// ---------------------------------------------------------------------------

export interface ExportAllOptions {
  destPath: string;
  includeBookmarks: boolean;
  includeAnalyses: boolean;
  includeProcessors: boolean;
  editorTabs: LtsEditorTabPayload[];
  /** Ui-only "Anonymize PII in exported log lines" opt-in; ignored for an agent caller. */
  anonymize: boolean;
}
