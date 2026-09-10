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
}
