//! The single wire vocabulary both transports speak.
//!
//! Today the UI gets `offset`/`count` lists while the MCP bridge invents
//! `max_results`/`truncated` with a different key per endpoint (`matches`,
//! `events`, `sections`, `transitions`). These types replace all of that: one
//! envelope per concept, `camelCase`, used by the command path and the HTTP
//! path alike.
//!
//! **No `ts-rs` derives yet** — WP-0b adds `#[derive(TS)]` here together with
//! the export test and the `.cargo/config.toml` wiring. Everything in this
//! file is shaped so that adding the derive is a one-line change per type.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::core::line::ViewLine;

use crate::commands::pipeline::PipelineRunSummary;
use ts_rs::TS;

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/// A bounded window over a larger ordered collection.
///
/// `total` is the full count the window was taken from, so a caller can page
/// without a second request. `truncated` is `true` when the service stopped
/// early for a reason other than reaching `total` — a scan cap, a mid-scan
/// session removal — which is a different fact from `items.len() < total`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub offset: usize,
    pub limit: usize,
    pub total: usize,
    pub truncated: bool,
}

impl<T> Page<T> {
    /// A complete, untruncated page starting at offset 0.
    pub fn full(items: Vec<T>) -> Self {
        let total = items.len();
        Self {
            offset: 0,
            limit: total,
            total,
            truncated: false,
            items,
        }
    }

    /// A window into `total` items starting at `offset` with cap `limit`.
    pub fn window(items: Vec<T>, offset: usize, limit: usize, total: usize) -> Self {
        Self {
            items,
            offset,
            limit,
            total,
            truncated: false,
        }
    }

    /// Mark the page as cut short by something other than `total`.
    pub fn truncated(mut self, truncated: bool) -> Self {
        self.truncated = truncated;
        self
    }
}

/// How a service picked which lines to return when it could not return them
/// all. Requested by the caller; echoed back on [`Sampled`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LineStrategy {
    /// Evenly spaced across the whole scanned range.
    #[default]
    Uniform,
    /// The most recent matching lines.
    Recent,
    /// A window centred on one line.
    Around { line: usize },
    /// Everything in `[start, end)`, in order.
    Range { start: usize, end: usize },
}

/// A sample of a collection too large to return whole.
///
/// Distinct from [`Page`]: a page is a contiguous window a caller can advance,
/// a sample is a lossy selection described by its [`LineStrategy`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Sampled<T> {
    pub items: Vec<T>,
    pub strategy: LineStrategy,
    /// Human-readable note explaining what the sample represents, for agents.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub strategy_note: Option<String>,
    /// How many items the sample contains (== `items.len()`, carried
    /// explicitly because MCP clients read it without materializing `items`).
    pub sampled_count: usize,
    /// How many source lines were examined to produce this sample.
    pub scanned_lines: usize,
    pub truncated: bool,
}

impl<T> Sampled<T> {
    pub fn new(items: Vec<T>, strategy: LineStrategy, scanned_lines: usize) -> Self {
        Self {
            sampled_count: items.len(),
            items,
            strategy,
            strategy_note: None,
            scanned_lines,
            truncated: false,
        }
    }

    pub fn with_note(mut self, note: impl Into<String>) -> Self {
        self.strategy_note = Some(note.into());
        self
    }

    pub fn truncated(mut self, truncated: bool) -> Self {
        self.truncated = truncated;
        self
    }
}

/// A value that had to be shortened, carried alongside the fact that it was.
///
/// Used where a consumer must be able to tell "this is the whole thing" from
/// "this is the head of something bigger" — raw line text past the character
/// cap, oversized var maps, and so on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Truncated<T> {
    pub value: T,
    pub truncated: bool,
    /// The full size before truncation, in whatever unit the value counts in
    /// (characters for text, entries for a map).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub original_len: Option<usize>,
}

impl<T> Truncated<T> {
    pub fn intact(value: T) -> Self {
        Self {
            value,
            truncated: false,
            original_len: None,
        }
    }

    pub fn cut(value: T, original_len: usize) -> Self {
        Self {
            value,
            truncated: true,
            original_len: Some(original_len),
        }
    }
}

// ---------------------------------------------------------------------------
// Concrete responses
// ---------------------------------------------------------------------------

/// Tag and level histograms over a set of returned lines. Cheap orientation
/// for an agent deciding what to look at next, which is why it rides along
/// with a sampled page rather than needing a second request.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LineStats {
    #[ts(type = "Record<string, number>")]
    pub tag_counts: HashMap<String, usize>,
    #[ts(type = "Record<string, number>")]
    pub level_counts: HashMap<String, usize>,
}

/// A set of log lines and how they were chosen — the unified replacement for
/// the UI's `LineWindow { totalLines, lines }` and the bridge's bespoke
/// `{ lineNum, level, tag, raw }` array. [`ViewLine`] is the single element
/// type on both paths.
///
/// Covers both kinds of read. A contiguous window (the viewer's normal scroll)
/// leaves the sampling metadata absent; a sample the service had to *choose* —
/// evenly spaced, most recent, centred on a line, or the survivors of a bounded
/// scan — fills in [`strategy`](Self::strategy) and its companions so the
/// caller can tell what it is looking at.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LinePage {
    pub session_id: String,
    pub total_lines: usize,
    pub offset: usize,
    pub count: usize,
    pub truncated: bool,
    pub lines: Vec<ViewLine>,
    // ── sampling metadata ──────────────────────────────────────────────────
    // Absent when the page is a plain contiguous window (the viewer's normal
    // read), present when the service had to choose which lines to return.
    // Together with `count` (== `sampledCount`) and `truncated` these are the
    // [`Sampled`] fields; they live inline rather than as a nested `Sampled`
    // so one type describes both kinds of read.
    /// How the lines were chosen, when they were chosen rather than paged.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub strategy: Option<LineStrategy>,
    /// Human-readable explanation of the sample, for agents.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub strategy_note: Option<String>,
    /// How many source lines were examined. Only set when the service had to
    /// scan (a content filter was active); a plain sample examines nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scanned_lines: Option<usize>,
    /// Tag/level histograms over `lines`, when the caller asked for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stats: Option<LineStats>,
}

/// One line that matched a search, together with the lines around it.
///
/// The single element shape behind both of today's search endpoints.
/// `h_search` renders `line` plus two sibling arrays; `h_search_with_context`
/// renders one flat list in reading order and marks the match with
/// `isMatch` — which is [`ViewLine::is_context`] inverted, so no information
/// is lost either way. Every string here has already been through
/// [`policy::redact_line`](crate::services::policy::redact_line).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// The matching line itself. [`is_context`](ViewLine::is_context) is false.
    pub line: ViewLine,
    /// Up to `context_before` lines immediately preceding the match, in
    /// ascending line order.
    pub context_before: Vec<ViewLine>,
    /// Up to `context_after` lines immediately following the match, in
    /// ascending line order.
    pub context_after: Vec<ViewLine>,
    /// Regex capture groups 1..n of this match, in order, with non-participating
    /// groups dropped. Empty when the pattern has no groups — or when the
    /// caller asked for a membership test rather than captures.
    pub captures: Vec<String>,
}

/// A page of search hits, plus what it took to find them.
///
/// `total` is the number of matches the scan *counted*, which is not always
/// `hits.len()`: a caller that only wants the first page stops scanning once
/// it has `limit` hits and then the two agree, while a caller that wants an
/// exact count keeps scanning past the page. `truncated` says the scan itself
/// stopped short — the [`MCP_SCAN_LINE_CAP`](crate::services::lines::MCP_SCAN_LINE_CAP)
/// bound, or the session disappearing mid-scan — which is a different fact
/// from `hits.len() < total`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchHits {
    pub session_id: String,
    /// Matches counted across the scanned range (see the type docs).
    pub total: usize,
    /// How many hits are in this page (== `hits.len()`).
    pub returned: usize,
    /// Matches skipped before collecting this page.
    pub offset: usize,
    /// The page size that was applied.
    pub limit: usize,
    pub truncated: bool,
    /// How many source lines the scan examined.
    pub scanned_lines: usize,
    /// Total lines in the session, for orientation — the scan range may be
    /// narrower.
    pub total_lines: usize,
    pub hits: Vec<SearchHit>,
}

/// The result of one pipeline run.
///
/// `effective_processor_ids` is the chain the backend actually ran, after
/// resolving bare ids and applying the session's active/disabled sets — so a
/// caller that passed `None` learns what it got rather than having to
/// re-derive it (which is what `mcp_bridge::h_run_pipeline` does today, and
/// what `usePipelineCommands.ts` duplicates on the frontend).
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunResult {
    pub session_id: String,
    pub effective_processor_ids: Vec<String>,
    pub summaries: Vec<PipelineRunSummary>,
}

// ---------------------------------------------------------------------------
// MCP bridge response envelopes (WP-13)
// ---------------------------------------------------------------------------
//
// Every `/mcp/...` route answers with one of the types below (or with a type
// already defined above, or with a domain type that is itself `Serialize + TS`
// — `Bookmark`, `AnalysisArtifact`, `WatchInfo`, `StateSnapshot`,
// `ProcessorSummary`, `Insights`, …). Nothing in `mcp_bridge/**` builds a
// response with `serde_json::json!` any more, which is what makes
// `mcp-server/`'s TypeScript client typeable from the generated bindings.
//
// Naming note: a few of these deliberately shadow a `services::*` type of the
// same name (`ReporterDetail`, `TrackerDetail`, `ProcessorDetail`,
// `BridgeSessionMetadata`). The service type is the *computation's* result —
// `Option<String>` raw text, `Value` emissions, non-`Serialize`; the twin here
// is the *wire* shape. The route is the mapping between them, and keeping the
// names parallel is what makes that mapping obvious.

/// The machine-readable half of the one error envelope every route uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WireErrorDetail {
    /// [`ServiceError::code`](crate::services::ServiceError::code) — stable,
    /// matched by clients. Never localize or reword it.
    pub code: String,
    /// [`ServiceError::message`](crate::services::ServiceError::message) —
    /// human-readable, and deliberately uninformative for gate refusals (a
    /// denied and a nonexistent path both say `path is not allowed`).
    pub message: String,
}

/// The body of every non-2xx bridge response: `{ "error": { code, message } }`.
///
/// Produced solely by `impl IntoResponse for ServiceError` in
/// `mcp_bridge::respond`, so the status line and this body can never disagree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WireError {
    pub error: WireErrorDetail,
}

impl WireError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            error: WireErrorDetail {
                code: code.into(),
                message: message.into(),
            },
        }
    }
}

/// `{ "ok": true }` — the body of a mutation whose only interesting outcome is
/// that it happened. Path parameters the caller already knows (session id,
/// filter id, …) are not echoed back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    pub ok: bool,
}

impl Ack {
    pub fn ok() -> Self {
        Self { ok: true }
    }
}

// ── sessions ───────────────────────────────────────────────────────────────

/// `GET /mcp/status`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatusInfo {
    /// Always `true` — the bridge is the thing answering.
    pub running: bool,
    pub port: u16,
    pub session_count: usize,
    pub session_ids: Vec<String>,
    /// How many processors are installed. (Pre-WP-13 this key held the count
    /// under the name `installedProcessors`; it is now spelled for what it is.)
    pub installed_processor_count: usize,
}

/// One source inside a `GET /mcp/sessions` entry.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSessionSource {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub total_lines: usize,
    /// Absolute source-file path; `null` for an ADB stream.
    pub path: Option<String>,
}

/// One `GET /mcp/sessions` entry.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSessionEntry {
    pub id: String,
    pub sources: Vec<BridgeSessionSource>,
    pub focused: bool,
}

/// One installed processor, as `GET /mcp/sessions` summarises it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInstalledProcessor {
    pub id: String,
    pub name: String,
    pub processor_type: String,
}

/// `GET /mcp/sessions`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSessionList {
    pub sessions: Vec<BridgeSessionEntry>,
    pub processors_with_results: Vec<String>,
    pub installed_processors: Vec<BridgeInstalledProcessor>,
}

/// `POST /mcp/open_file`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession {
    pub session_id: String,
    pub source_type: String,
    pub total_lines: usize,
    pub is_indexing: bool,
}

/// `GET /mcp/sessions/{session_id}/metadata` — the light shape (no level/tag
/// scan), with a section count the rich command-side `SessionMetadata` does not
/// compute.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSessionMetadata {
    pub session_id: String,
    pub source_name: String,
    pub source_type: String,
    pub total_lines: usize,
    #[ts(type = "number")]
    pub file_size: u64,
    pub is_live: bool,
    pub is_indexing: bool,
    #[ts(type = "number | null")]
    pub first_timestamp: Option<i64>,
    #[ts(type = "number | null")]
    pub last_timestamp: Option<i64>,
    pub section_count: usize,
}

// ── tracker / correlator / sections ────────────────────────────────────────

/// One state transition tagged with the tracker that produced it —
/// the element of `GET /mcp/sessions/{session_id}/events`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TrackerEventEntry {
    pub tracker_id: String,
    pub transition_name: String,
    pub line_num: usize,
    #[ts(type = "number")]
    pub timestamp: i64,
    // `#[ts(type)]` clears ts-rs's dependency tracking, so the named value type
    // must be pulled in with an inline import — every generated file is a sibling.
    #[ts(type = "Record<string, import('./FieldChange').FieldChange>")]
    pub changes: HashMap<String, crate::processors::state_tracker::types::FieldChange>,
}

/// One correlation event, narrowed for the bridge.
///
/// Deliberately NOT the full `CorrelationEvent`: that type carries
/// `triggerRawLine` and the complete per-source `matchedSources` records, i.e.
/// raw log text. Every raw-line pathway out of the bridge has to run through
/// [`policy::redact_line`](crate::services::policy::redact_line), and
/// `services::correlator` does not redact, so this endpoint keeps exposing only
/// the structured trigger fields it always has.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CorrelationSummary {
    pub trigger_line_num: usize,
    #[ts(type = "number")]
    pub trigger_timestamp: i64,
    pub trigger_source_id: String,
    #[ts(type = "Record<string, unknown>")]
    pub trigger_fields: HashMap<String, serde_json::Value>,
    pub message: String,
    /// Which other sources contributed a match, by id. The records themselves
    /// are withheld (see the type docs).
    pub matched_source_ids: Vec<String>,
}

/// One correlator's page of events plus its author-supplied guidance.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CorrelatorEvents {
    pub correlator_id: String,
    pub guidance: Option<String>,
    pub events: Page<CorrelationSummary>,
}

/// `GET /mcp/sessions/{session_id}/correlations`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionCorrelations {
    pub session_id: String,
    pub correlators: Vec<CorrelatorEvents>,
}

/// `GET /mcp/sessions/{session_id}/section_at?line=N`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SectionLocation {
    pub session_id: String,
    pub line: usize,
    /// The name a processor's `filter.section` must use to match this line;
    /// `null` when no rule can target it by section.
    pub matches_filter_section: Option<String>,
    /// Every section covering `line`, outermost first.
    pub containing_sections: Vec<crate::core::session::SectionInfo>,
    pub total_lines_in_session: usize,
    /// Guidance when `matchesFilterSection` and `containingSections` disagree,
    /// or when the source has no sections at all.
    pub note: Option<String>,
}

// ── pipeline ───────────────────────────────────────────────────────────────

/// One matched line. `rawLine` is `null` when the caller did not ask for line
/// text (or the session could not resolve it) — distinct from `""`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MatchedLineEntry {
    pub line_num: usize,
    pub raw_line: Option<String>,
}

/// One reporter emission.
///
/// Pre-WP-13 this shape leaked `Emission`'s hand-written `Serialize`
/// (`{ "line_num": N, "fields": { … } }` — snake_case in an otherwise
/// camelCase wire) with `rawLine` spliced into the same object. It is a real
/// type now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EmissionEntry {
    pub line_num: usize,
    #[ts(type = "Record<string, unknown>")]
    pub fields: serde_json::Map<String, serde_json::Value>,
    pub raw_line: Option<String>,
}

/// One state transition, with the (redacted) text of the line that produced it.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TransitionEntry {
    pub line_num: usize,
    #[ts(type = "number")]
    pub timestamp: i64,
    pub transition_name: String,
    #[ts(type = "Record<string, import('./FieldChange').FieldChange>")]
    pub changes: HashMap<String, crate::processors::state_tracker::types::FieldChange>,
    pub raw_line: Option<String>,
}

/// One reporter's aggregated results in the pipeline listing.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReporterSummary {
    pub processor_id: String,
    /// Always `"reporter"` — the discriminant for a client switching on the
    /// two arms of a pipeline listing.
    pub processor_type: String,
    pub name: String,
    pub description: String,
    /// Pre-WP-13 this count was spelled `matchedLines`, which collided with the
    /// *array* of the same name on the detail endpoint.
    pub matched_line_count: usize,
    pub emission_count: usize,
    /// The last 10 emissions, newest first.
    pub recent_emissions: Vec<EmissionEntry>,
    /// The first 5 matched lines, with text.
    pub sample_matched_lines: Vec<MatchedLineEntry>,
    #[ts(type = "Record<string, unknown>")]
    pub vars: serde_json::Map<String, serde_json::Value>,
}

/// One state tracker's aggregated results in the pipeline listing.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TrackerSummary {
    pub processor_id: String,
    /// Always `"state_tracker"`.
    pub processor_type: String,
    pub name: String,
    pub description: String,
    pub transition_count: usize,
    #[ts(type = "unknown")]
    pub final_state: serde_json::Value,
    /// The last 20 transitions, newest first.
    pub recent_transitions: Vec<TransitionEntry>,
}

/// `GET /mcp/sessions/{session_id}/pipeline`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionPipelineResults {
    pub session_id: String,
    pub has_results: bool,
    pub reporters: Vec<ReporterSummary>,
    pub state_trackers: Vec<TrackerSummary>,
}

/// The reporter arm of `GET /mcp/sessions/{session_id}/processor/{id}`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReporterDetail {
    /// The caller's spelling of the id, not the bare→qualified resolution —
    /// bare in, bare out.
    pub processor_id: String,
    pub session_id: String,
    /// Always `"reporter"`.
    pub processor_type: String,
    pub name: String,
    pub description: String,
    pub matched_line_count: usize,
    pub emission_count: usize,
    #[ts(type = "Record<string, unknown>")]
    pub vars: serde_json::Map<String, serde_json::Value>,
    /// The first 100 matched lines.
    pub matched_lines: Vec<MatchedLineEntry>,
    /// `null` when `include_emissions` was not requested — the page is not
    /// materialized at all in that case, which is why this is not an empty
    /// [`Page`].
    pub emissions: Option<Page<EmissionEntry>>,
}

/// The state-tracker arm of `GET /mcp/sessions/{session_id}/processor/{id}`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TrackerDetail {
    pub processor_id: String,
    pub session_id: String,
    /// Always `"state_tracker"`.
    pub processor_type: String,
    pub name: String,
    pub description: String,
    pub transition_count: usize,
    #[ts(type = "unknown")]
    pub final_state: serde_json::Value,
    pub transitions: Page<TransitionEntry>,
}

/// `GET /mcp/sessions/{session_id}/processor/{processor_id}`.
///
/// Untagged: each arm carries its own `processorType` discriminant, so a
/// client switches on that rather than on an extra envelope key.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(untagged)]
pub enum ProcessorDetail {
    Reporter(ReporterDetail),
    StateTracker(TrackerDetail),
}

// ── ADB stream ─────────────────────────────────────────────────────────────

/// `GET /mcp/adb/devices`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AdbDeviceList {
    pub devices: Vec<crate::services::stream::AdbDevice>,
}

/// `POST /mcp/adb/stream`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamStarted {
    pub session_id: String,
    pub source_name: String,
    pub status: crate::services::stream::StreamStatus,
}

/// One entry of the polled agent event feed: the ring's monotonic sequence
/// number plus the event it stored.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamEventEntry {
    // Ring sequence numbers are `u64` in Rust but never approach 2^53 in
    // practice (the ring holds 2000 items and the counter is per-session,
    // per-process), so `number` is the honest TS type — `bigint` would make
    // every consumer coerce.
    #[ts(type = "number")]
    pub seq: u64,
    pub item: crate::services::stream::AdbStreamEvent,
}

/// `GET /mcp/sessions/{session_id}/stream/events`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamEventsPage {
    pub session_id: String,
    /// Highest sequence the ring has issued, in or out of `events`.
    #[ts(type = "number")]
    pub latest_seq: u64,
    /// Cursor to send as `since` on the next poll.
    #[ts(type = "number")]
    pub next_since: u64,
    /// True when events between the caller's cursor and the oldest retained
    /// item were evicted — they are gone for good.
    pub gap: bool,
    pub events: Vec<StreamEventEntry>,
}

/// `POST /mcp/sessions/{session_id}/stream/save`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamSaved {
    pub session_id: String,
    pub lines_written: u32,
}

// ── workspace ──────────────────────────────────────────────────────────────

/// `GET /mcp/workspaces`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceList {
    pub workspaces: Vec<crate::workspace::app_state::WorkspaceEntry>,
}

/// `POST /mcp/workspace/save` and `POST /mcp/workspace/autosave`.
///
/// One shape for both: pre-WP-13 `save` said `destPath` and `autosave` said
/// `path` for the same fact.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSaved {
    pub saved: bool,
    pub path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn page_serializes_camel_case_with_all_five_keys() {
        let p = Page::window(vec![1u32, 2], 10, 2, 57);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(
            v,
            json!({ "items": [1, 2], "offset": 10, "limit": 2, "total": 57, "truncated": false })
        );
    }

    #[test]
    fn page_full_sets_total_and_limit_from_len() {
        let p = Page::full(vec!["a", "b", "c"]);
        assert_eq!(p.total, 3);
        assert_eq!(p.limit, 3);
        assert_eq!(p.offset, 0);
        assert!(!p.truncated);
    }

    #[test]
    fn page_truncated_builder_sets_the_flag() {
        let p = Page::full(vec![1u8]).truncated(true);
        assert!(p.truncated);
    }

    #[test]
    fn line_strategy_is_tagged_by_kind() {
        assert_eq!(
            serde_json::to_value(LineStrategy::Uniform).unwrap(),
            json!({ "kind": "uniform" })
        );
        assert_eq!(
            serde_json::to_value(LineStrategy::Around { line: 42 }).unwrap(),
            json!({ "kind": "around", "line": 42 })
        );
        assert_eq!(
            serde_json::to_value(LineStrategy::Range { start: 1, end: 9 }).unwrap(),
            json!({ "kind": "range", "start": 1, "end": 9 })
        );
        assert_eq!(LineStrategy::default(), LineStrategy::Uniform);
    }

    #[test]
    fn sampled_counts_items_and_omits_absent_note() {
        let s = Sampled::new(vec![1u32, 2, 3], LineStrategy::Uniform, 5000);
        assert_eq!(s.sampled_count, 3);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["scannedLines"], 5000);
        assert_eq!(v["sampledCount"], 3);
        assert!(v.get("strategyNote").is_none());
    }

    #[test]
    fn sampled_with_note_emits_it() {
        let s = Sampled::new(vec![1u32], LineStrategy::Recent, 10).with_note("last 1 of 10");
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["strategyNote"], "last 1 of 10");
    }

    #[test]
    fn truncated_intact_omits_original_len() {
        let t = Truncated::intact("short".to_string());
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["truncated"], false);
        assert!(v.get("originalLen").is_none());
    }

    #[test]
    fn truncated_cut_reports_original_len() {
        let t = Truncated::cut("abc...".to_string(), 900);
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["truncated"], true);
        assert_eq!(v["originalLen"], 900);
    }

    #[test]
    fn line_page_keys_are_camel_case() {
        let p = LinePage {
            session_id: "s1".into(),
            total_lines: 100,
            offset: 0,
            count: 0,
            truncated: false,
            lines: vec![],
            strategy: None,
            strategy_note: None,
            scanned_lines: None,
            stats: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["totalLines"], 100);
        assert!(v["lines"].is_array());
        // The sampling metadata is absent, not null, on a plain window read.
        for absent in ["strategy", "strategyNote", "scannedLines", "stats"] {
            assert!(v.get(absent).is_none(), "{absent} should be omitted");
        }
    }

    #[test]
    fn pipeline_run_result_reports_the_effective_chain() {
        let r = PipelineRunResult {
            session_id: "s1".into(),
            effective_processor_ids: vec!["wifi-state@official".into()],
            summaries: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["effectiveProcessorIds"][0], "wifi-state@official");
        assert!(v["summaries"].as_array().unwrap().is_empty());
    }

    // ── WP-13 bridge envelopes ─────────────────────────────────────────────

    #[test]
    fn wire_error_is_a_nested_code_message_object() {
        let e = WireError::new("NOT_FOUND", "Session 's1' not found");
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "error": { "code": "NOT_FOUND", "message": "Session 's1' not found" } })
        );
    }

    #[test]
    fn ack_is_just_ok_true() {
        assert_eq!(serde_json::to_value(Ack::ok()).unwrap(), json!({ "ok": true }));
    }

    #[test]
    fn emission_entry_is_camel_case_not_the_old_snake_case_quirk() {
        let mut fields = serde_json::Map::new();
        fields.insert("kind".to_string(), json!("anr"));
        let e = EmissionEntry {
            line_num: 7,
            fields,
            raw_line: Some("raw".to_string()),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["lineNum"], 7);
        assert_eq!(v["rawLine"], "raw");
        assert_eq!(v["fields"]["kind"], "anr");
        assert!(v.get("line_num").is_none(), "the snake_case quirk is gone");
    }

    #[test]
    fn processor_detail_is_untagged_and_discriminated_by_processor_type() {
        let d = ProcessorDetail::Reporter(ReporterDetail {
            processor_id: "r".into(),
            session_id: "s1".into(),
            processor_type: "reporter".into(),
            name: "R".into(),
            description: String::new(),
            matched_line_count: 0,
            emission_count: 0,
            vars: serde_json::Map::new(),
            matched_lines: vec![],
            emissions: None,
        });
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["processorType"], "reporter");
        assert!(v.get("Reporter").is_none(), "untagged: no variant wrapper");
        assert_eq!(v["emissions"], json!(null));
    }
}
