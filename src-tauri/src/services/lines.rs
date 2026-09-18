//! `lines` — the one implementation of "give me some log lines".
//!
//! Before this file existed there were three: `commands::files::get_lines`
//! (the viewer window, three `ViewMode`s), `mcp_bridge::routes::lines::h_query`
//! (sampled/filtered agent reads) and `h_lines_around` (a window around one
//! line). They read the same `LogSource` through the same `sessions` lock and
//! disagreed about almost everything else — element shape, redaction,
//! truncation, whether an unreadable line is skipped or emitted empty.
//!
//! [`get_lines`] is now the only one. Callers describe *which* lines they want
//! with a [`LineSelection`] plus optional [`LineFilters`], and get back a
//! [`LinePage`] of [`ViewLine`]s. Both transports now ship that page straight
//! through: `commands/files.rs::get_lines` returns it to the viewer and
//! `mcp_bridge/routes/lines.rs` serializes it to the agent. The transitional
//! `LineWindow` narrowing and the bespoke bridge JSON are both gone.
//!
//! ## Redaction
//!
//! Every returned line's text goes through [`policy::redact_lines`] *after* the
//! `sessions` lock has been dropped — anonymize first, truncate second, one
//! lock acquisition per page. This is an `Internal` pathway
//! (`policy::should_anonymize`): a [`Caller::Ui`](crate::services::Caller::Ui)
//! is redacted only under anonymizer mode `All` and, with `max_line_chars:
//! None`, never truncated — under the default `External` the viewer's bytes
//! are untouched. When a line is redacted its search highlights are
//! recomputed against the redacted text, so the viewer never paints spans
//! that pointed into the original.
//!
//! Search and filters still *match* on raw text: under `All`, searching for
//! an email finds the line and shows it as `<EMAIL-1>`; searching for
//! `<EMAIL-1>` finds nothing.
//!
//! ## Locking
//!
//! One `AppState` lock at a time, never across an `.await` (this function is
//! synchronous — the bridge wraps it in `spawn_blocking`). The filtered scan
//! path re-acquires `sessions` once per [`MCP_SCAN_CHUNK_SIZE`] lines rather
//! than holding it for the whole scan, exactly as the bridge handler did.

use std::collections::{HashMap, HashSet};

use regex::Regex;

use crate::core::line::{HighlightKind, HighlightSpan, LogLevel, SearchQuery, ViewLine, ViewMode};
use crate::core::log_source::LogSource;
use crate::core::parser::LogParser;
use crate::core::session::{AnalysisSession, parser_for};
use crate::services::policy::{redact_lines, should_anonymize};
use crate::services::wire::{LinePage, LineStats, LineStrategy};
use crate::services::{ServiceCtx, ServiceError, lock_svc};

// ---------------------------------------------------------------------------
// Scan bounds — moved here from `mcp_bridge::respond`
// ---------------------------------------------------------------------------
//
// These are the shared budget for every raw-line scan in the backend, so they
// belong to the service layer rather than to one transport. `respond.rs` keeps
// thin re-exports because `routes/search.rs` (WP-2) still imports them from
// there; when WP-2 lands, those re-exports go.

/// Lines scanned per lock acquisition. Matches `commands::files::search_logs`'s
/// `SEARCH_CHUNK_SIZE` so both raw-line scan paths behave consistently.
pub const MCP_SCAN_CHUNK_SIZE: usize = 10_000;

/// Hard cap on total lines scanned across all chunks for a single request.
/// Without this, a rarely-matching regex/filter over a 20M-line bugreport
/// would scan the entire file on every call — chunking alone stops it from
/// starving other lock holders, but the request could still run for a very
/// long time. Callers that need to see past the cap can page with
/// `start_line`/`end_line`.
pub const MCP_SCAN_LINE_CAP: usize = 500_000;

/// True if `[range_start, range_end)` is wider than `scan_cap` — i.e. the
/// scan window had to be capped down. Pure so the truncation math is unit
/// testable without a live session/lock.
pub fn scan_window_capped(range_start: usize, range_end: usize, scan_cap: usize) -> bool {
    range_end.saturating_sub(range_start) > scan_cap
}

/// The effective (possibly capped) end of a scan window starting at
/// `range_start`, given the caller-requested `range_end` and `scan_cap`.
/// Equal to `range_end` when the window already fits under the cap.
pub fn capped_range_end(range_start: usize, range_end: usize, scan_cap: usize) -> usize {
    range_start.saturating_add(scan_cap).min(range_end)
}

/// Split `[start, end)` into consecutive `[chunk_start, chunk_end)` windows
/// of at most `chunk_size` lines each, in ascending order. Pure — used to
/// scan under short-lived `sessions` lock acquisitions (one per window)
/// instead of holding the lock for a single large scan.
pub fn scan_chunk_bounds(start: usize, end: usize, chunk_size: usize) -> Vec<(usize, usize)> {
    if start >= end || chunk_size == 0 {
        return Vec::new();
    }
    let mut bounds = Vec::new();
    let mut cur = start;
    while cur < end {
        let next = (cur + chunk_size).min(end);
        bounds.push((cur, next));
        cur = next;
    }
    bounds
}

/// Case-insensitive substring test that avoids allocating a lowercased copy
/// of `haystack` for the common case where the haystack is pure ASCII (log
/// lines almost always are). `needle_lower` must already be lowercased via
/// `str::to_lowercase()`.
///
/// ASCII lowering is a 1:1 byte mapping and agrees with Unicode
/// `to_lowercase()` for ASCII input, so a byte-wise sliding-window scan is
/// safe and exact for that case. For a haystack containing any non-ASCII byte
/// we fall back to `haystack.to_lowercase().contains(needle_lower)` so Unicode
/// case-folding edge cases (e.g. Turkish İ -> "i̇", two chars) still match
/// exactly as before.
pub fn contains_ignore_case(haystack: &str, needle_lower: &str) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    if haystack.is_ascii() {
        let hay_bytes = haystack.as_bytes();
        let needle_bytes = needle_lower.as_bytes();
        if needle_bytes.len() > hay_bytes.len() {
            return false;
        }
        hay_bytes
            .windows(needle_bytes.len())
            .any(|w| w.iter().zip(needle_bytes).all(|(a, b)| a.to_ascii_lowercase() == *b))
    } else {
        haystack.to_lowercase().contains(needle_lower)
    }
}

/// Returns true if `line_level` (e.g. "Info") is >= the minimum `filter`
/// (e.g. "W" or "Warn"). Comparison is by priority: V < D < I < W < E < F.
///
/// Deliberately string-based rather than [`LogLevel`]-based: the filter comes
/// off an HTTP query string and may be anything, and both sides fall back to
/// Info for an unrecognised value.
pub fn level_at_least(line_level: &str, filter: &str) -> bool {
    fn priority(s: &str) -> u8 {
        match s.to_uppercase().chars().next().unwrap_or('I') {
            'V' => 0,
            'D' => 1,
            'W' => 3,
            'E' => 4,
            'F' => 5,
            _ => 2, // 'I' and unknown
        }
    }
    priority(line_level) >= priority(filter)
}

/// Locate every occurrence of `query` in `raw`, as spans for the viewer (and
/// the MCP bridge) to highlight.
///
/// Moved here from `commands::files` (WP-1 review) — a pure function over
/// [`core::line`](crate::core::line) types, so it belongs with the rest of
/// `services` rather than pulled backward from `commands/`.
pub fn compute_search_highlights(raw: &str, query: &SearchQuery) -> Vec<HighlightSpan> {
    if query.text.is_empty() {
        return vec![];
    }

    let mut spans = Vec::new();

    if query.is_regex {
        let pattern = if query.case_sensitive {
            query.text.clone()
        } else {
            format!("(?i){}", query.text)
        };
        if let Ok(re) = Regex::new(&pattern) {
            for m in re.find_iter(raw) {
                spans.push(HighlightSpan {
                    start: m.start(),
                    end: m.end(),
                    kind: HighlightKind::Search,
                });
            }
        }
    } else if query.case_sensitive {
        let mut offset = 0;
        while let Some(pos) = raw[offset..].find(query.text.as_str()) {
            let abs = offset + pos;
            spans.push(HighlightSpan {
                start: abs,
                end: abs + query.text.len(),
                kind: HighlightKind::Search,
            });
            offset = abs + query.text.len().max(1);
            if offset >= raw.len() {
                break;
            }
        }
    } else {
        let lower_raw = raw.to_lowercase();
        let lower_needle = query.text.to_lowercase();
        let mut offset = 0;
        while let Some(pos) = lower_raw[offset..].find(&lower_needle) {
            let abs = offset + pos;
            spans.push(HighlightSpan {
                start: abs,
                end: abs + lower_needle.len(),
                kind: HighlightKind::Search,
            });
            offset = abs + lower_needle.len().max(1);
            if offset >= lower_raw.len() {
                break;
            }
        }
    }

    spans
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/// The message a caller gets when the session exists but carries no source.
///
/// Both transports rewrite this into their own historical spelling; it is a
/// named constant so the bridge adapter can recognise it without matching on a
/// literal. WP-13 deletes both rewrites and ships [`ServiceError`] directly.
pub const NO_SOURCES: &str = "No sources in session";

/// Which lines to select, before filtering.
///
/// **Deviation from the WP-1 brief, deliberate:** the brief named four
/// variants with `Around { line, before, after }` covering both "a window
/// around a line" and "N lines centred on a line". Those are not the same
/// function — `h_lines_around` clamps at the log's start and returns *fewer*
/// lines, while `h_query`'s `around` sampling *shifts the window* to keep
/// returning `n`. Collapsing them would have changed one endpoint's output, so
/// they are separate variants ([`Around`](Self::Around) and
/// [`Centered`](Self::Centered)) and both behaviours are preserved exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineSelection {
    /// `count` lines evenly spaced across the whole scan range.
    Uniform { count: usize },
    /// The newest `count` lines in the scan range.
    Recent { count: usize },
    /// Exactly `[line - before, line + after]`, clamped to the scan range —
    /// never widened to compensate for the clamp. Used by the viewer's
    /// `Focus` mode and by `lines_around`.
    Around {
        line: usize,
        before: usize,
        after: usize,
    },
    /// `count` lines centred on `line` (defaulting to the end of the range),
    /// with the window *shifted* to stay `count` wide when the centre sits
    /// near a boundary. Used by `query`'s `around` sampling.
    Centered { line: Option<usize>, count: usize },
    /// The contiguous window `[offset, offset + limit)` of the scan range.
    Range { offset: usize, limit: usize },
}

impl LineSelection {
    /// How many lines this selection asks for — the match budget on the
    /// filtered scan path.
    fn budget(&self) -> usize {
        match self {
            LineSelection::Uniform { count }
            | LineSelection::Recent { count }
            | LineSelection::Centered { count, .. } => *count,
            LineSelection::Around { before, after, .. } => {
                before.saturating_add(*after).saturating_add(1)
            }
            LineSelection::Range { limit, .. } => *limit,
        }
    }

    /// The centre line, for the strategies that have one.
    fn center(&self) -> Option<usize> {
        match self {
            LineSelection::Around { line, .. } => Some(*line),
            LineSelection::Centered { line, .. } => *line,
            _ => None,
        }
    }
}

/// Filters narrowing which lines qualify. When any of the four content
/// filters is set the service switches from index sampling to a bounded scan
/// (see [`LineFilters::is_active`]); `start_line`/`end_line` only clamp the
/// range and do not by themselves trigger a scan — matching what `h_query`
/// has always done.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineFilters {
    /// Restrict to lines >= this index (0-based, inclusive).
    pub start_line: Option<usize>,
    /// Restrict to lines < this index (0-based, exclusive).
    pub end_line: Option<usize>,
    /// Minimum log level, compared by first character (see [`level_at_least`]).
    pub min_level: Option<String>,
    /// Exact tag match.
    pub tag: Option<String>,
    /// Case-insensitive substring of the raw line.
    pub text: Option<String>,
    /// Lower bound on `LineMeta::timestamp` (Unix-epoch nanos).
    pub time_start_ns: Option<i64>,
    /// Upper bound on `LineMeta::timestamp` (Unix-epoch nanos).
    pub time_end_ns: Option<i64>,
}

impl LineFilters {
    /// True when a content filter is set, i.e. when selection must become a scan.
    pub fn is_active(&self) -> bool {
        self.min_level.is_some()
            || self.tag.is_some()
            || self.text.is_some()
            || self.time_start_ns.is_some()
            || self.time_end_ns.is_some()
    }
}

/// Which of a parser's two views describes a returned line's `level`, `tag`
/// and `timestamp`.
///
/// **Deviation from the WP-1 brief, deliberate:** the brief said "parsed via
/// `parser_for`", which is what the viewer has always done. The bridge never
/// did — `h_query` and `h_lines_around` read the stored
/// [`LineMeta`](crate::core::line::LineMeta) written by `parse_meta` at index
/// time. For a logcat source the two agree (both branches of `LogcatParser`
/// derive level and tag from the same captures), but for a **bugreport** they
/// do not: `BugreportParser::parse_meta` classifies a line by its enclosing
/// dumpstate section (tag `"MEMORY INFO"`, …) while `parse_line` delegates to
/// `LogcatParser`, which tags most of those lines `""`. Collapsing the two
/// would have silently emptied the `tag` field of every bugreport line the MCP
/// bridge serves, so the choice is a request parameter and each transport
/// keeps the view it shipped. WP-13 picks one deliberately.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LineMetadataSource {
    /// `parse_line` first, stored `LineMeta` as the fallback. The viewer's
    /// historical behaviour, and the richer one — it fills `pid`/`tid` and a
    /// parsed `message` distinct from `raw`.
    #[default]
    Parsed,
    /// The stored `LineMeta` only, never `parse_line`. The bridge's historical
    /// behaviour: `message == raw`, `pid`/`tid` zero.
    Indexed,
}

/// One request for lines.
#[derive(Debug, Clone)]
pub struct LinesRequest {
    pub session_id: String,
    pub selection: LineSelection,
    pub filters: LineFilters,
    /// `Full` uses [`selection`](Self::selection) as written; `Processor`
    /// collapses to one processor's matched lines plus context and paginates
    /// that with `selection`'s offset/limit; `Focus(c)` overrides the
    /// selection with a window around `c`.
    pub view_mode: ViewMode,
    /// Required by [`ViewMode::Processor`].
    pub processor_id: Option<String>,
    /// Context lines: the half-window in `Processor` mode, and (floored at 25)
    /// the half-window in `Focus` mode.
    pub context: usize,
    /// When set, highlight spans are computed for each returned line.
    pub search: Option<SearchQuery>,
    /// Per-line character cap applied *after* anonymization. `None` means no cap.
    pub max_line_chars: Option<usize>,
    /// Compute tag/level histograms over the returned lines.
    pub with_stats: bool,
    /// Skip lines whose raw text or metadata cannot be read (evicted from a
    /// stream buffer with no spill) instead of emitting them with empty text.
    /// The agent endpoints skip; the viewer emits, so its line numbering stays
    /// aligned with the scrollback.
    pub skip_unreadable: bool,
    /// Which view of a line fills `level`/`tag`/`timestamp`. See
    /// [`LineMetadataSource`].
    pub metadata: LineMetadataSource,
}

impl LinesRequest {
    /// A request for the contiguous window `[offset, offset + limit)` of a
    /// session, with viewer defaults (no stats, no cap, nothing skipped).
    pub fn range(session_id: impl Into<String>, offset: usize, limit: usize) -> Self {
        Self {
            session_id: session_id.into(),
            selection: LineSelection::Range { offset, limit },
            filters: LineFilters::default(),
            view_mode: ViewMode::Full,
            processor_id: None,
            context: 0,
            search: None,
            max_line_chars: None,
            with_stats: false,
            skip_unreadable: false,
            metadata: LineMetadataSource::Parsed,
        }
    }

    /// Replace the selection.
    pub fn select(mut self, selection: LineSelection) -> Self {
        self.selection = selection;
        self
    }

    /// Replace the filters.
    pub fn filter(mut self, filters: LineFilters) -> Self {
        self.filters = filters;
        self
    }

    /// Agent-side defaults: stats on, unreadable lines skipped, indexed
    /// metadata (what the MCP bridge has always served — see
    /// [`LineMetadataSource`]).
    pub fn for_agent(mut self, max_line_chars: Option<usize>) -> Self {
        self.max_line_chars = max_line_chars;
        self.with_stats = true;
        self.skip_unreadable = true;
        self.metadata = LineMetadataSource::Indexed;
        self
    }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/// Read lines from a session.
///
/// Synchronous by contract: it takes `AppState` locks and does bounded CPU
/// work, so async callers wrap it in `spawn_blocking` rather than have it hold
/// a lock across an await point.
pub fn get_lines(ctx: &ServiceCtx, req: LinesRequest) -> Result<LinePage, ServiceError> {
    // Resolve the redaction decision before touching `sessions` — it takes the
    // `agent_raw_access` lock, and the two must never nest.
    let anonymizing = should_anonymize(ctx, &req.session_id);

    let mut page = match req.view_mode {
        ViewMode::Processor => collect_processor(ctx, &req)?,
        ViewMode::Focus(center) => {
            let half = req.context.max(25);
            let focused = LinesRequest {
                selection: LineSelection::Around {
                    line: center,
                    before: half,
                    after: half,
                },
                ..req.clone()
            };
            collect_window(ctx, &focused)?
        }
        ViewMode::Full => collect_window(ctx, &req)?,
    };

    // Redaction happens here, after every `sessions` acquisition above has been
    // released: `redact_lines` takes `anonymizer_config` / `mcp_anonymizers`,
    // and nesting those under `sessions` is the lock-order
    // violation the bridge's module header warns about. One lock acquisition
    // per page (not per line) — under mode `All` this is the viewer's scroll
    // path.
    let max_chars = req.max_line_chars.unwrap_or(usize::MAX);
    if anonymizing || max_chars != usize::MAX {
        redact_view_lines(ctx, &req.session_id, &mut page.lines, max_chars, req.search.as_ref());
    }

    if req.with_stats {
        page.stats = Some(stats_for(&page.lines));
    }
    Ok(page)
}

/// Redact `raw` and `message` of every view line in place, in order, through
/// [`redact_lines`] — the batch form every page-shaped raw-text service uses
/// (`get_lines`, `filters::lines`, `search::hits`, `stream::events`).
///
/// A parsed message differs from its raw line (the logcat header is stripped)
/// and gets its own pass; an unparsed one mirrors `raw` and simply takes the
/// redacted raw. Both passes hit the same cached anonymizer, so the tokens
/// agree. Order is preserved end to end because token numbering follows first
/// sight — a caller that wants a particular reading order hands the lines
/// over in that order.
///
/// Highlight spans are byte offsets into the pre-redaction text, so a line
/// whose text changed gets them recomputed against `search` (or cleared when
/// the caller has no query).
pub(crate) fn redact_view_lines<'a>(
    ctx: &ServiceCtx,
    session_id: &str,
    lines: impl IntoIterator<Item = &'a mut ViewLine>,
    max_chars: usize,
    search: Option<&SearchQuery>,
) {
    let mut lines: Vec<&mut ViewLine> = lines.into_iter().collect();
    if lines.is_empty() {
        return;
    }

    let mut raws: Vec<String> = lines.iter().map(|l| l.raw.clone()).collect();
    redact_lines(ctx, session_id, &mut raws, max_chars);

    let own_message: Vec<bool> = lines
        .iter()
        .zip(&raws)
        .map(|(l, redacted)| l.message != l.raw && *redacted != l.raw)
        .collect();
    let mut messages: Vec<String> = lines
        .iter()
        .zip(&own_message)
        .filter(|(_, own)| **own)
        .map(|(l, _)| l.message.clone())
        .collect();
    redact_lines(ctx, session_id, &mut messages, max_chars);
    let mut messages = messages.into_iter();

    for (i, line) in lines.iter_mut().enumerate() {
        let redacted = std::mem::take(&mut raws[i]);
        if redacted == line.raw {
            continue;
        }
        line.message = if own_message[i] {
            messages.next().expect("one redacted message per parsed line")
        } else {
            redacted.clone()
        };
        line.highlights = match search {
            Some(q) => compute_search_highlights(&redacted, q),
            None => Vec::new(),
        };
        line.raw = redacted;
    }
}

/// Tag and level histograms over the lines actually returned.
fn stats_for(lines: &[ViewLine]) -> LineStats {
    let mut tag_counts: HashMap<String, usize> = HashMap::new();
    let mut level_counts: HashMap<String, usize> = HashMap::new();
    for line in lines {
        *tag_counts.entry(line.tag.clone()).or_insert(0) += 1;
        *level_counts
            .entry(line.level.as_str().to_string())
            .or_insert(0) += 1;
    }
    LineStats {
        tag_counts,
        level_counts,
    }
}

// ---------------------------------------------------------------------------
// Full / Focus
// ---------------------------------------------------------------------------

fn collect_window(ctx: &ServiceCtx, req: &LinesRequest) -> Result<LinePage, ServiceError> {
    let filtered = req.filters.is_active();

    // Phase 1 — resolve the scan range and pick indices. On the unfiltered
    // path this is one lock acquisition; on the filtered path it is one per
    // `MCP_SCAN_CHUNK_SIZE` lines.
    let (total_lines, range_start, range_end) = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let session = sessions
            .get(&req.session_id)
            .ok_or_else(|| ServiceError::session_not_found(&req.session_id))?;
        let source = session
            .primary_source()
            .ok_or_else(|| ServiceError::invalid_arg(NO_SOURCES))?;
        let total = source.total_lines();
        let start = req.filters.start_line.unwrap_or(0).min(total);
        let end = req.filters.end_line.unwrap_or(total).min(total);
        (total, start, end.max(start))
    };

    let (indices, scanned, scan_truncated) = if filtered {
        scan_matching(ctx, req, range_start, range_end)?
    } else {
        (
            select_indices(&req.selection, range_start, range_end),
            0,
            false,
        )
    };

    // Phase 2 — materialize the lines under one fresh `sessions` acquisition.
    let center = req.selection.center().or(match req.view_mode {
        ViewMode::Focus(c) => Some(c),
        _ => None,
    });
    let lines = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let session = sessions
            .get(&req.session_id)
            .ok_or_else(|| ServiceError::session_not_found(&req.session_id))?;
        let source = session
            .primary_source()
            .ok_or_else(|| ServiceError::invalid_arg(NO_SOURCES))?;
        let parser = parser_for(source.source_type());

        let mut out = Vec::with_capacity(indices.len());
        for &i in &indices {
            if req.skip_unreadable
                && (source.raw_line(i).is_none() || source.meta_at(i).is_none())
            {
                continue;
            }
            let is_context = center.is_some_and(|c| c != i);
            out.push(build_view_line(
                parser.as_ref(),
                session,
                source,
                i,
                i,
                req.search.as_ref(),
                Vec::new(),
                is_context,
                req.metadata,
            ));
        }
        out
    };

    let offset = match req.selection {
        LineSelection::Range { .. } => indices.first().copied().unwrap_or(range_start),
        _ => indices.first().copied().unwrap_or(0),
    };

    Ok(LinePage {
        session_id: req.session_id.clone(),
        total_lines,
        offset,
        count: lines.len(),
        truncated: scan_truncated,
        lines,
        strategy: Some(describe(&req.selection, range_start, range_end, &indices)),
        strategy_note: strategy_note(&req.selection, filtered),
        scanned_lines: filtered.then_some(scanned),
        stats: None,
    })
}

/// The wire-level description of what the selection actually resolved to.
fn describe(
    sel: &LineSelection,
    range_start: usize,
    range_end: usize,
    indices: &[usize],
) -> LineStrategy {
    match sel {
        LineSelection::Uniform { .. } => LineStrategy::Uniform,
        LineSelection::Recent { .. } => LineStrategy::Recent,
        LineSelection::Around { line, .. } => LineStrategy::Around { line: *line },
        LineSelection::Centered { line, .. } => LineStrategy::Around {
            line: line.unwrap_or_else(|| range_end.saturating_sub(1)),
        },
        LineSelection::Range { .. } => LineStrategy::Range {
            start: indices.first().copied().unwrap_or(range_start),
            end: indices.last().map_or(range_start, |l| l + 1),
        },
    }
}

fn strategy_note(sel: &LineSelection, filtered: bool) -> Option<String> {
    if filtered {
        return Some(format!(
            "Filters active — scanned in {} order, capped at {MCP_SCAN_LINE_CAP} lines",
            order_label(sel)
        ));
    }
    match sel {
        LineSelection::Uniform { count } => {
            Some(format!("{count} lines evenly spaced across the range"))
        }
        LineSelection::Recent { count } => Some(format!("the newest {count} lines")),
        LineSelection::Centered { count, .. } => Some(format!("{count} lines around the centre")),
        LineSelection::Around { .. } | LineSelection::Range { .. } => None,
    }
}

fn order_label(sel: &LineSelection) -> &'static str {
    match sel {
        LineSelection::Recent { .. } => "recent",
        LineSelection::Around { .. } | LineSelection::Centered { .. } => "around",
        LineSelection::Uniform { .. } | LineSelection::Range { .. } => "uniform",
    }
}

/// Pure index selection over `[range_start, range_end)`.
fn select_indices(sel: &LineSelection, range_start: usize, range_end: usize) -> Vec<usize> {
    let len = range_end.saturating_sub(range_start);
    if len == 0 {
        return Vec::new();
    }
    match sel {
        LineSelection::Recent { count } => {
            let n = (*count).min(len);
            (range_end - n..range_end).collect()
        }
        LineSelection::Uniform { count } => {
            let n = (*count).min(len);
            if n >= len {
                (range_start..range_end).collect()
            } else {
                (0..n).map(|i| range_start + (i * len) / n).collect()
            }
        }
        LineSelection::Centered { line, count } => {
            let n = (*count).min(len);
            let center_rel = line
                .map(|l| l.saturating_sub(range_start))
                .unwrap_or_else(|| len - 1);
            let start_rel = center_rel.saturating_sub(n / 2);
            let end_rel = (start_rel + n).min(len);
            (range_start + start_rel..range_start + end_rel).collect()
        }
        LineSelection::Around {
            line,
            before,
            after,
        } => {
            let start = line.saturating_sub(*before).max(range_start);
            let end = line.saturating_add(*after).saturating_add(1).min(range_end);
            if start >= end {
                Vec::new()
            } else {
                (start..end).collect()
            }
        }
        LineSelection::Range { offset, limit } => {
            let start = range_start.saturating_add(*offset).min(range_end);
            let end = start.saturating_add(*limit).min(range_end);
            (start..end).collect()
        }
    }
}

/// The bounded, chunked scan used whenever a content filter is active.
///
/// Returns `(matched indices in ascending order, lines scanned, truncated)`.
fn scan_matching(
    ctx: &ServiceCtx,
    req: &LinesRequest,
    range_start: usize,
    range_end: usize,
) -> Result<(Vec<usize>, usize, bool), ServiceError> {
    let budget = req.selection.budget();
    let cap_applied = scan_window_capped(range_start, range_end, MCP_SCAN_LINE_CAP);
    let reverse = matches!(req.selection, LineSelection::Recent { .. });

    // Build the scan order. Capped as it is materialized — without the cap,
    // "uniform" in particular would allocate one usize per line of the session.
    let scan_indices: Vec<usize> = match &req.selection {
        LineSelection::Recent { .. } => {
            let start = range_start.max(range_end.saturating_sub(MCP_SCAN_LINE_CAP));
            (start..range_end).rev().collect()
        }
        LineSelection::Around { line, .. } | LineSelection::Centered { line: Some(line), .. } => {
            outward_from(*line, range_start, range_end)
        }
        LineSelection::Centered { line: None, .. } => {
            outward_from(range_end.saturating_sub(1), range_start, range_end)
        }
        LineSelection::Uniform { .. } | LineSelection::Range { .. } => {
            let end = capped_range_end(range_start, range_end, MCP_SCAN_LINE_CAP);
            (range_start..end).collect()
        }
    };

    let needle = req.filters.text.as_ref().map(|m| m.to_lowercase());
    let mut matched: Vec<usize> = Vec::new();
    let mut scanned: usize = 0;
    let mut session_lost = false;

    // Chunk the materialized index list rather than a range: the "around"
    // order interleaves forward and backward, so it is not contiguous. The
    // `sessions` lock is dropped between chunks so other holders get a turn.
    'chunks: for chunk in scan_indices.chunks(MCP_SCAN_CHUNK_SIZE) {
        if matched.len() >= budget {
            break;
        }
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let Some(session) = sessions.get(&req.session_id) else {
            session_lost = true;
            break 'chunks;
        };
        let Some(source) = session.primary_source() else {
            session_lost = true;
            break 'chunks;
        };
        for &i in chunk {
            if matched.len() >= budget {
                break;
            }
            scanned += 1;
            let Some(raw) = source.raw_line(i) else { continue };
            let Some(meta) = source.meta_at(i) else { continue };
            if let Some(ref want) = req.filters.tag {
                if session.resolve_tag(meta.tag_id) != want {
                    continue;
                }
            }
            if let Some(ref needle) = needle {
                if !contains_ignore_case(&raw, needle.as_str()) {
                    continue;
                }
            }
            if let Some(ref min) = req.filters.min_level {
                if !level_at_least(meta.level.as_str(), min) {
                    continue;
                }
            }
            if let Some(ts) = req.filters.time_start_ns {
                if meta.timestamp < ts {
                    continue;
                }
            }
            if let Some(ts) = req.filters.time_end_ns {
                if meta.timestamp > ts {
                    continue;
                }
            }
            matched.push(i);
        }
    }

    // "recent" scanned newest -> oldest; restore chronological order.
    if reverse {
        matched.reverse();
    }
    let truncated = session_lost || (cap_applied && matched.len() < budget);
    Ok((matched, scanned, truncated))
}

/// Interleave outward from `center`: center, center-1, center+1, … bounded by
/// `[range_start, range_end)` and by half of [`MCP_SCAN_LINE_CAP`] either way.
fn outward_from(center: usize, range_start: usize, range_end: usize) -> Vec<usize> {
    if range_start >= range_end {
        return Vec::new();
    }
    let center = center.clamp(range_start, range_end - 1);
    let half = MCP_SCAN_LINE_CAP / 2;
    let start = center.saturating_sub(half).max(range_start);
    let end = (center + half).min(range_end);
    (start..=center)
        .rev()
        .zip(((center + 1)..end).map(Some).chain(std::iter::repeat(None)))
        .flat_map(|(b, a)| std::iter::once(b).chain(a))
        .collect()
}

// ---------------------------------------------------------------------------
// Processor mode
// ---------------------------------------------------------------------------

fn collect_processor(ctx: &ServiceCtx, req: &LinesRequest) -> Result<LinePage, ServiceError> {
    let proc_id = req
        .processor_id
        .as_deref()
        .ok_or_else(|| ServiceError::invalid_arg("processor_id required for Processor mode"))?;

    // Read the last run's matched lines first, so `pipeline_results` and
    // `sessions` are never held at the same time.
    let matched: Vec<usize> = {
        let pr = lock_svc(&ctx.state().pipeline_results, "pipeline_results")?;
        pr.get(&req.session_id)
            .and_then(|s| s.get(proc_id))
            .map(|r| r.matched_line_nums.clone())
            .unwrap_or_default()
    };

    let (offset, limit) = match req.selection {
        LineSelection::Range { offset, limit } => (offset, limit),
        _ => (0, req.selection.budget()),
    };

    let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
    let session = sessions
        .get(&req.session_id)
        .ok_or_else(|| ServiceError::session_not_found(&req.session_id))?;
    let source = session
        .primary_source()
        .ok_or_else(|| ServiceError::invalid_arg(NO_SOURCES))?;
    let total_lines = source.total_lines();

    if matched.is_empty() {
        return Ok(empty_page(&req.session_id, total_lines));
    }

    // Collapse matches plus context into an ordered, deduplicated line list.
    let mut to_show: Vec<usize> = Vec::new();
    for &m in &matched {
        let start = m.saturating_sub(req.context);
        let end = (m + req.context + 1).min(total_lines);
        for ln in start..end {
            if to_show.last() != Some(&ln) {
                to_show.push(ln);
            }
        }
    }
    to_show.sort_unstable();
    to_show.dedup();

    let total_collapsed = to_show.len();
    let page_start = offset.min(total_collapsed);
    let page_end = (page_start + limit).min(total_collapsed);
    let page = &to_show[page_start..page_end];

    let matched_set: HashSet<usize> = matched.iter().copied().collect();
    let parser = parser_for(source.source_type());

    let mut lines = Vec::with_capacity(page.len());
    for (pos, &ln) in page.iter().enumerate() {
        // Historic behaviour: a line with no metadata is dropped from the
        // collapsed view rather than emitted with defaults.
        if source.meta_at(ln).is_none() {
            continue;
        }
        let is_match = matched_set.contains(&ln);
        lines.push(build_view_line(
            parser.as_ref(),
            session,
            source,
            ln,
            page_start + pos,
            req.search.as_ref(),
            if is_match {
                vec![proc_id.to_string()]
            } else {
                Vec::new()
            },
            !is_match,
            req.metadata,
        ));
    }

    Ok(LinePage {
        session_id: req.session_id.clone(),
        total_lines: total_collapsed,
        offset: page_start,
        count: lines.len(),
        truncated: false,
        lines,
        strategy: None,
        strategy_note: None,
        scanned_lines: None,
        stats: None,
    })
}

fn empty_page(session_id: &str, total_lines: usize) -> LinePage {
    LinePage {
        session_id: session_id.to_string(),
        total_lines,
        offset: 0,
        count: 0,
        truncated: false,
        lines: Vec::new(),
        strategy: None,
        strategy_note: None,
        scanned_lines: None,
        stats: None,
    }
}

// ---------------------------------------------------------------------------
// ViewLine construction
// ---------------------------------------------------------------------------

/// Build one [`ViewLine`].
///
/// With [`LineMetadataSource::Parsed`] the parser's view of the line wins and
/// the stored [`LineMeta`](crate::core::line::LineMeta) is the fallback for
/// section headers and anything the parser does not recognise; with
/// [`LineMetadataSource::Indexed`] the parser is not consulted at all and the
/// stored meta is used directly.
///
/// `raw_line`/`meta_at` are used (never direct indexing) so a stream source's
/// eviction offset is applied.
#[allow(clippy::too_many_arguments)]
fn build_view_line(
    parser: &dyn LogParser,
    session: &AnalysisSession,
    source: &dyn LogSource,
    line_num: usize,
    virtual_index: usize,
    search: Option<&SearchQuery>,
    matched_by: Vec<String>,
    is_context: bool,
    metadata: LineMetadataSource,
) -> ViewLine {
    let raw = source.raw_line(line_num).as_deref().unwrap_or("").to_string();
    let meta = source.meta_at(line_num);
    let highlights = search
        .map(|q| compute_search_highlights(&raw, q))
        .unwrap_or_default();

    let parsed = match metadata {
        LineMetadataSource::Parsed => parser.parse_line(&raw, source.id(), line_num),
        LineMetadataSource::Indexed => None,
    };

    match parsed {
        Some(c) => ViewLine {
            line_num,
            virtual_index,
            raw: c.raw.to_string(),
            level: c.level,
            tag: c.tag.to_string(),
            message: c.message.to_string(),
            timestamp: c.timestamp,
            pid: c.pid,
            tid: c.tid,
            source_id: c.source_id.to_string(),
            highlights,
            matched_by,
            is_context,
        },
        None => ViewLine {
            line_num,
            virtual_index,
            raw: raw.clone(),
            level: meta.map_or(LogLevel::Info, |m| m.level),
            tag: meta.map_or_else(String::new, |m| session.resolve_tag(m.tag_id).to_string()),
            message: raw,
            timestamp: meta.map_or(0, |m| m.timestamp),
            pid: 0,
            tid: 0,
            source_id: source.id().to_string(),
            highlights,
            matched_by,
            is_context,
        },
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session::AnalysisSession;
    use crate::services::Caller;
    use crate::services::testing::{fixture_session_from, test_ctx};

    fn page_lines(page: &LinePage) -> Vec<usize> {
        page.lines.iter().map(|l| l.line_num).collect()
    }

    fn raws(page: &LinePage) -> Vec<&str> {
        page.lines.iter().map(|l| l.raw.as_str()).collect()
    }

    // ── select_indices — the pure selection math ────────────────────────────

    #[test]
    fn uniform_spaces_evenly_and_never_exceeds_the_range() {
        assert_eq!(
            select_indices(&LineSelection::Uniform { count: 4 }, 0, 100),
            vec![0, 25, 50, 75]
        );
        // count >= range returns every line, once.
        assert_eq!(
            select_indices(&LineSelection::Uniform { count: 50 }, 0, 3),
            vec![0, 1, 2]
        );
        // A clamped range is spaced within the clamp, not the whole log.
        assert_eq!(
            select_indices(&LineSelection::Uniform { count: 2 }, 10, 20),
            vec![10, 15]
        );
    }

    #[test]
    fn recent_takes_the_tail_of_the_range() {
        assert_eq!(
            select_indices(&LineSelection::Recent { count: 3 }, 0, 100),
            vec![97, 98, 99]
        );
        assert_eq!(
            select_indices(&LineSelection::Recent { count: 3 }, 10, 20),
            vec![17, 18, 19]
        );
        // Asking for more than exists is not an error.
        assert_eq!(
            select_indices(&LineSelection::Recent { count: 99 }, 0, 2),
            vec![0, 1]
        );
    }

    #[test]
    fn centered_shifts_its_window_to_stay_count_wide() {
        // Mid-range: centred.
        assert_eq!(
            select_indices(
                &LineSelection::Centered {
                    line: Some(50),
                    count: 4
                },
                0,
                100
            ),
            vec![48, 49, 50, 51]
        );
        // Near the start: shifted rather than shortened — this is exactly what
        // separates `Centered` from `Around`.
        assert_eq!(
            select_indices(
                &LineSelection::Centered {
                    line: Some(0),
                    count: 4
                },
                0,
                100
            ),
            vec![0, 1, 2, 3]
        );
        // No centre given means "the last line". The window is centred on it
        // and then clipped at the end, so it comes back short — `Centered`
        // only shifts away from the *start* boundary. Frozen behaviour: the
        // pre-service `sample_indices("around", …)` did exactly this.
        assert_eq!(
            select_indices(&LineSelection::Centered { line: None, count: 3 }, 0, 100),
            vec![98, 99]
        );
    }

    #[test]
    fn around_clamps_at_the_boundaries_and_never_widens() {
        assert_eq!(
            select_indices(
                &LineSelection::Around {
                    line: 50,
                    before: 2,
                    after: 2
                },
                0,
                100
            ),
            vec![48, 49, 50, 51, 52]
        );
        // Line 0: fewer lines come back, the window is NOT shifted right.
        assert_eq!(
            select_indices(
                &LineSelection::Around {
                    line: 0,
                    before: 20,
                    after: 2
                },
                0,
                100
            ),
            vec![0, 1, 2]
        );
        // Past EOF: nothing.
        assert!(
            select_indices(
                &LineSelection::Around {
                    line: 5_000,
                    before: 2,
                    after: 2
                },
                0,
                100
            )
            .is_empty()
        );
    }

    #[test]
    fn range_is_a_plain_window_of_the_scan_range() {
        assert_eq!(
            select_indices(&LineSelection::Range { offset: 2, limit: 3 }, 0, 100),
            vec![2, 3, 4]
        );
        // Offset past the end is empty, not an error.
        assert!(select_indices(&LineSelection::Range { offset: 500, limit: 3 }, 0, 100).is_empty());
        // An empty range yields nothing for every selection.
        for sel in [
            LineSelection::Uniform { count: 5 },
            LineSelection::Recent { count: 5 },
            LineSelection::Range { offset: 0, limit: 5 },
        ] {
            assert!(select_indices(&sel, 7, 7).is_empty(), "{sel:?}");
        }
    }

    // ── get_lines — windows and edges ───────────────────────────────────────

    #[test]
    fn a_plain_window_reports_the_session_total_not_the_window_size() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 200).build();
        let page = get_lines(&ctx, LinesRequest::range("s1", 10, 5)).unwrap();
        assert_eq!(page.total_lines, 200);
        assert_eq!(page.offset, 10);
        assert_eq!(page.count, 5);
        assert_eq!(page_lines(&page), vec![10, 11, 12, 13, 14]);
        assert!(!page.truncated);
    }

    #[test]
    fn around_line_zero_returns_a_short_window_and_marks_the_centre() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 50).build();
        let req = LinesRequest::range("s1", 0, 0).select(LineSelection::Around {
            line: 0,
            before: 20,
            after: 3,
        });
        let page = get_lines(&ctx, req).unwrap();
        assert_eq!(page_lines(&page), vec![0, 1, 2, 3]);
        assert!(!page.lines[0].is_context, "line 0 is the centre");
        assert!(page.lines[1].is_context);
    }

    #[test]
    fn around_past_eof_returns_an_empty_page_rather_than_an_error() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 50).build();
        let req = LinesRequest::range("s1", 0, 0).select(LineSelection::Around {
            line: 5_000,
            before: 10,
            after: 10,
        });
        let page = get_lines(&ctx, req).unwrap();
        assert_eq!(page.count, 0);
        assert!(page.lines.is_empty());
        // The session total still reports honestly, so a caller can tell
        // "past the end" from "empty session".
        assert_eq!(page.total_lines, 50);
    }

    #[test]
    fn an_unknown_session_is_not_found_and_a_sourceless_one_is_an_invalid_arg() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 3).build();
        assert_eq!(
            get_lines(&ctx, LinesRequest::range("nope", 0, 5)).unwrap_err(),
            ServiceError::session_not_found("nope")
        );

        let bare = AnalysisSession::new("bare".to_string());
        let (ctx2, _tmp2) = test_ctx().with_session_object(bare).build();
        assert_eq!(
            get_lines(&ctx2, LinesRequest::range("bare", 0, 5)).unwrap_err(),
            ServiceError::invalid_arg(NO_SOURCES)
        );
    }

    #[test]
    fn reads_are_never_journaled() {
        let (ctx, sink, _tmp) = test_ctx()
            .agent("claude-code")
            .with_session("s1", 20)
            .build_recording();
        get_lines(&ctx, LinesRequest::range("s1", 0, 5).for_agent(None)).unwrap();
        assert!(
            sink.is_empty(),
            "a read must not touch the activity feed: {:?}",
            sink.events()
        );
    }

    // ── Filters ─────────────────────────────────────────────────────────────

    #[test]
    fn a_content_filter_switches_from_sampling_to_a_reported_scan() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 200).build();

        let unfiltered = get_lines(
            &ctx,
            LinesRequest::range("s1", 0, 0).select(LineSelection::Recent { count: 3 }),
        )
        .unwrap();
        assert_eq!(
            unfiltered.scanned_lines, None,
            "a plain sample examines nothing"
        );

        let filtered = get_lines(
            &ctx,
            LinesRequest::range("s1", 0, 0)
                .select(LineSelection::Recent { count: 3 })
                .filter(LineFilters {
                    text: Some("line 1".into()),
                    ..Default::default()
                }),
        )
        .unwrap();
        assert!(filtered.scanned_lines.unwrap() > 0);
        // "recent" scans newest-first, but the page it returns is
        // chronological — the scan order is an implementation detail.
        let nums = page_lines(&filtered);
        assert_eq!(nums.len(), 3);
        assert!(nums.windows(2).all(|w| w[0] < w[1]), "out of order: {nums:?}");
        assert!(raws(&filtered).iter().all(|r| r.contains("line 1")));
    }

    #[test]
    fn start_and_end_line_clamp_the_range_without_triggering_a_scan() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 200).build();
        let page = get_lines(
            &ctx,
            LinesRequest::range("s1", 0, 0)
                .select(LineSelection::Recent { count: 3 })
                .filter(LineFilters {
                    start_line: Some(10),
                    end_line: Some(20),
                    ..Default::default()
                }),
        )
        .unwrap();
        assert_eq!(page_lines(&page), vec![17, 18, 19]);
        assert_eq!(
            page.scanned_lines, None,
            "a range clamp alone is not a content filter"
        );
    }

    #[test]
    fn a_filter_matching_nothing_yields_an_empty_page_not_an_error() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 50).build();
        let page = get_lines(
            &ctx,
            LinesRequest::range("s1", 0, 0)
                .select(LineSelection::Uniform { count: 5 })
                .filter(LineFilters {
                    text: Some("no-such-text".into()),
                    ..Default::default()
                }),
        )
        .unwrap();
        assert_eq!(page.count, 0);
        assert_eq!(page.scanned_lines, Some(50), "the whole range was examined");
        assert!(!page.truncated, "a fully-examined range is not truncated");
    }

    // ── Redaction ───────────────────────────────────────────────────────────

    #[test]
    fn an_agent_is_redacted_by_default_and_the_ui_never_is() {
        // Neither context configures anything — the default is redacted.
        let (agent, _t1) = test_ctx()
            .agent("claude-code")
            .with_pii_session("p1", 5)
            .build();
        let (ui, _t2) = test_ctx().with_pii_session("p1", 5).build();

        let req = || LinesRequest::range("p1", 0, 3).for_agent(None);
        let agent_page = get_lines(&agent, req()).unwrap();
        let ui_page = get_lines(&ui, req()).unwrap();

        assert!(
            raws(&agent_page).iter().all(|r| !r.contains("@example.com")),
            "an agent must be redacted with no configuration: {:?}",
            raws(&agent_page)
        );
        assert!(
            raws(&ui_page).iter().all(|r| r.contains("@example.com")),
            "a Ui caller is the owner of the machine and is never redacted"
        );
    }

    #[test]
    fn an_agent_sees_raw_text_after_the_user_opted_out() {
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_pii_session("p1", 3)
            .agent_raw_access(true)
            .build();
        let page = get_lines(&ctx, LinesRequest::range("p1", 0, 3).for_agent(None)).unwrap();
        assert!(raws(&page).iter().all(|r| r.contains("@example.com")));
    }

    #[test]
    fn truncation_is_applied_after_anonymization_and_the_ui_is_never_truncated() {
        let long = format!("head {} tail user@example.com", "x".repeat(1_000));
        let make = |caller: Caller| {
            let b = test_ctx()
                .caller(caller)
                .with_session_object(fixture_session_from("long", vec![long.clone()]));
            b.build()
        };

        let (agent, _t1) = make(Caller::agent("claude-code"));
        let page = get_lines(&agent, LinesRequest::range("long", 0, 1).for_agent(Some(500))).unwrap();
        let raw = &page.lines[0].raw;
        assert_eq!(raw.chars().count(), 503, "500 chars plus the ellipsis");
        assert!(raw.ends_with("..."));
        assert!(!raw.contains("user@example.com"), "PII is removed before the cut");

        let (ui, _t2) = make(Caller::Ui);
        let page = get_lines(&ui, LinesRequest::range("long", 0, 1)).unwrap();
        assert_eq!(
            page.lines[0].raw.chars().count(),
            long.chars().count(),
            "the viewer's bytes are untouched"
        );
    }

    fn plain_query(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.into(),
            is_regex: false,
            case_sensitive: true,
            within_processor: None,
            min_level: None,
            tags: None,
            start_time: None,
            end_time: None,
        }
    }

    #[test]
    fn redaction_recomputes_highlight_spans_against_the_redacted_text() {
        // The fixture line is `line N contact userN@example.com for access`;
        // the email shrinks to a token, so a span computed on the original
        // would point at the wrong bytes of the returned text.
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_pii_session("p1", 3)
            .build();
        let mut req = LinesRequest::range("p1", 0, 3).for_agent(None);
        req.search = Some(plain_query("access"));
        let page = get_lines(&ctx, req).unwrap();
        for line in &page.lines {
            assert!(!line.raw.contains("@example.com"), "{}", line.raw);
            assert_eq!(line.highlights.len(), 1, "{:?}", line.highlights);
            let span = &line.highlights[0];
            assert_eq!(&line.raw[span.start..span.end], "access");
        }
    }

    #[test]
    fn redaction_drops_a_highlight_that_only_matched_the_redacted_value() {
        // Searching for the email finds the line (matching is on raw text);
        // the returned line no longer contains it, so there is nothing to
        // paint — an empty span list, not a stale one.
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .with_pii_session("p1", 1)
            .build();
        let mut req = LinesRequest::range("p1", 0, 1).for_agent(None);
        req.search = Some(plain_query("user0@example.com"));
        let page = get_lines(&ctx, req).unwrap();
        assert!(page.lines[0].highlights.is_empty());
    }

    // ── Anonymizer mode (Ui, Internal pathway) ──────────────────────────────

    #[test]
    fn ui_page_is_redacted_under_all_and_keeps_its_highlights() {
        let (ctx, _tmp) = test_ctx()
            .anonymizer_mode(crate::anonymizer::config::AnonymizerMode::All)
            .with_pii_session("p1", 3)
            .build();
        let mut req = LinesRequest::range("p1", 0, 3);
        req.search = Some(plain_query("contact"));
        let page = get_lines(&ctx, req).unwrap();
        assert_eq!(page.lines.len(), 3);
        for line in &page.lines {
            assert!(!line.raw.contains("@example.com"), "All: the viewer is anonymized: {}", line.raw);
            assert!(line.raw.contains("<EMAIL-"), "{}", line.raw);
            assert!(!line.message.contains("@example.com"), "{}", line.message);
            let span = &line.highlights[0];
            assert_eq!(&line.raw[span.start..span.end], "contact");
        }
    }

    #[test]
    fn ui_page_is_raw_under_external_and_none() {
        use crate::anonymizer::config::AnonymizerMode;
        for mode in [AnonymizerMode::External, AnonymizerMode::None] {
            let (ctx, _tmp) = test_ctx().anonymizer_mode(mode).with_pii_session("p1", 2).build();
            let page = get_lines(&ctx, LinesRequest::range("p1", 0, 2)).unwrap();
            assert!(page.lines.iter().all(|l| l.raw.contains("@example.com")), "{mode:?}");
        }
    }

    #[test]
    fn agent_page_is_raw_only_under_none() {
        use crate::anonymizer::config::AnonymizerMode;
        let (ctx, _tmp) = test_ctx()
            .agent("claude-code")
            .anonymizer_mode(AnonymizerMode::None)
            .with_pii_session("p1", 2)
            .build();
        let page = get_lines(&ctx, LinesRequest::range("p1", 0, 2).for_agent(None)).unwrap();
        assert!(page.lines.iter().all(|l| l.raw.contains("@example.com")), "None means none — agents too");
    }

    #[test]
    fn batch_redaction_equals_per_line_redaction() {
        // The page goes through `redact_lines` in one lock; a second state
        // redacted line-by-line through `redact_line` must produce the same
        // bytes and the same token numbers.
        let (batch, _t1) = test_ctx().agent("a").with_pii_session("p1", 4).build();
        let page = get_lines(&batch, LinesRequest::range("p1", 0, 4).for_agent(None)).unwrap();

        let (single, _t2) = test_ctx().agent("a").with_pii_session("p1", 4).build();
        let expected: Vec<String> = (0..4)
            .map(|i| {
                let raw = format!("line {i} contact user{i}@example.com for access");
                crate::services::policy::redact_line(&single, "p1", &raw, usize::MAX)
            })
            .collect();
        assert_eq!(raws(&page), expected.iter().map(String::as_str).collect::<Vec<_>>());
    }

    // ── Stream sources ──────────────────────────────────────────────────────

    /// `Recent` over a stream whose oldest lines have been evicted to the
    /// spill file. Line numbers are absolute — `evicted_count` must not shift
    /// them — and the evicted text is still readable through the spill.
    #[test]
    fn recent_on_a_stream_with_evicted_lines_keeps_absolute_numbering() {
        let mut session = fixture_session_from(
            "live",
            (0..100).map(|i| format!("line {i}")).collect(),
        );
        session
            .stream_source_mut()
            .expect("fixture is stream-backed")
            .evict(60);

        let (ctx, _tmp) = test_ctx().agent("a").with_session_object(session).build();

        let page = get_lines(
            &ctx,
            LinesRequest::range("live", 0, 0)
                .select(LineSelection::Recent { count: 3 })
                .for_agent(None),
        )
        .unwrap();
        assert_eq!(page.total_lines, 100, "eviction does not shrink the log");
        assert_eq!(page_lines(&page), vec![97, 98, 99]);
        assert_eq!(raws(&page), vec!["line 97", "line 98", "line 99"]);

        // A window entirely inside the evicted region still resolves, via spill.
        let page = get_lines(
            &ctx,
            LinesRequest::range("live", 0, 0)
                .select(LineSelection::Range { offset: 5, limit: 3 })
                .for_agent(None),
        )
        .unwrap();
        assert_eq!(page_lines(&page), vec![5, 6, 7]);
        assert_eq!(raws(&page), vec!["line 5", "line 6", "line 7"]);
    }

    /// The same shape, but with spilling broken so the evicted lines are
    /// genuinely gone. An agent caller skips them; the viewer keeps its
    /// numbering aligned with the scrollback by emitting them empty.
    #[test]
    fn unreadable_evicted_lines_are_skipped_for_an_agent_and_emitted_for_the_viewer() {
        let unwritable = std::env::temp_dir()
            .join("logtapper-wp1-no-such-dir")
            .join("nested");
        let make = || {
            let mut session = AnalysisSession::new("live".to_string());
            session.add_stream_source(
                "live-src".to_string(),
                "fixture".to_string(),
                unwritable.clone(),
            );
            if let Some(stream) = session.stream_source_mut() {
                for i in 0..20 {
                    stream.push_raw_line(format!("line {i}"));
                    stream.push_meta(crate::core::line::LineMeta {
                        level: LogLevel::Info,
                        tag_id: 0,
                        timestamp: 1_000_000_000 + i as i64,
                        byte_offset: 0,
                        byte_len: 0,
                        is_section_boundary: false,
                    });
                }
                stream.evict(10);
                assert!(!stream.has_spill(), "the spill file must have failed");
                assert_eq!(stream.lost_line_count(), 10);
            }
            session
        };

        let window = || LinesRequest::range("live", 5, 10);

        let (agent, _t1) = test_ctx().agent("a").with_session_object(make()).build();
        let page = get_lines(&agent, window().for_agent(None)).unwrap();
        assert_eq!(
            page_lines(&page),
            vec![10, 11, 12, 13, 14],
            "the five lost lines are dropped, not returned blank"
        );

        let (ui, _t2) = test_ctx().with_session_object(make()).build();
        let page = get_lines(&ui, window()).unwrap();
        assert_eq!(page_lines(&page), (5..15).collect::<Vec<_>>());
        assert!(
            raws(&page).iter().take(5).all(|r| r.is_empty()),
            "the viewer keeps the rows so its scrollback stays aligned"
        );
    }

    // ── Processor mode ──────────────────────────────────────────────────────

    fn with_matches(builder_session: AnalysisSession, matched: Vec<usize>) -> (ServiceCtx, tempfile::TempDir) {
        let (ctx, tmp) = test_ctx().with_session_object(builder_session).build();
        let mut per = HashMap::new();
        per.insert(
            "proc@x".to_string(),
            crate::processors::reporter::engine::RunResult {
                matched_line_nums: matched,
                ..Default::default()
            },
        );
        ctx.state()
            .pipeline_results
            .lock()
            .unwrap()
            .insert("s1".to_string(), per);
        (ctx, tmp)
    }

    #[test]
    fn processor_mode_collapses_matches_with_context_and_pages_the_result() {
        let (ctx, _tmp) = with_matches(
            fixture_session_from("s1", (0..100).map(|i| format!("line {i}")).collect()),
            vec![3, 4, 10, 50],
        );
        let mut req = LinesRequest::range("s1", 0, 100);
        req.view_mode = ViewMode::Processor;
        req.processor_id = Some("proc@x".into());
        req.context = 1;

        let page = get_lines(&ctx, req.clone()).unwrap();
        // 2..5 (from 3 and 4, overlapping), 9..11, 49..51 — deduplicated.
        assert_eq!(page_lines(&page), vec![2, 3, 4, 5, 9, 10, 11, 49, 50, 51]);
        assert_eq!(
            page.total_lines, 10,
            "in Processor mode the total is the collapsed view, not the log"
        );
        let matched: Vec<usize> = page
            .lines
            .iter()
            .filter(|l| !l.is_context)
            .map(|l| l.line_num)
            .collect();
        assert_eq!(matched, vec![3, 4, 10, 50]);
        assert_eq!(page.lines[1].matched_by, vec!["proc@x".to_string()]);
        assert!(page.lines[0].matched_by.is_empty());
        // `virtual_index` counts within the collapsed view, `line_num` in the log.
        assert_eq!(page.lines[4].virtual_index, 4);
        assert_eq!(page.lines[4].line_num, 9);

        // Paging keeps `virtual_index` absolute within the collapsed view.
        let mut paged = req;
        paged.selection = LineSelection::Range { offset: 4, limit: 3 };
        let page = get_lines(&ctx, paged).unwrap();
        assert_eq!(page_lines(&page), vec![9, 10, 11]);
        assert_eq!(page.offset, 4);
        assert_eq!(page.lines[0].virtual_index, 4);
    }

    #[test]
    fn processor_mode_with_no_run_reports_the_log_length_and_no_lines() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 40).build();
        let mut req = LinesRequest::range("s1", 0, 10);
        req.view_mode = ViewMode::Processor;
        req.processor_id = Some("never-ran@x".into());
        let page = get_lines(&ctx, req).unwrap();
        assert_eq!(page.count, 0);
        assert_eq!(page.total_lines, 40);
    }

    #[test]
    fn processor_mode_requires_a_processor_id() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 10).build();
        let mut req = LinesRequest::range("s1", 0, 10);
        req.view_mode = ViewMode::Processor;
        assert_eq!(
            get_lines(&ctx, req).unwrap_err(),
            ServiceError::invalid_arg("processor_id required for Processor mode")
        );
    }

    // ── Focus mode ──────────────────────────────────────────────────────────

    #[test]
    fn focus_mode_uses_a_minimum_half_window_of_25() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 200).build();
        let mut req = LinesRequest::range("s1", 0, 0);
        req.view_mode = ViewMode::Focus(100);
        req.context = 3; // below the floor
        let page = get_lines(&ctx, req).unwrap();
        assert_eq!(page_lines(&page), (75..=125).collect::<Vec<_>>());
        assert_eq!(page.total_lines, 200, "Focus reports the whole log");
        let centre = page.lines.iter().find(|l| l.line_num == 100).unwrap();
        assert!(!centre.is_context);
        assert!(page.lines.iter().filter(|l| !l.is_context).count() == 1);
    }

    // ── Stats ───────────────────────────────────────────────────────────────

    #[test]
    fn stats_are_computed_over_the_returned_lines_only_and_only_when_asked() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 200).build();
        let plain = get_lines(&ctx, LinesRequest::range("s1", 0, 5)).unwrap();
        assert!(plain.stats.is_none());

        let agent = get_lines(&ctx, LinesRequest::range("s1", 0, 5).for_agent(None)).unwrap();
        let stats = agent.stats.unwrap();
        assert_eq!(stats.level_counts.get("Info"), Some(&5));
        assert_eq!(stats.tag_counts.get(""), Some(&5));
    }

    // ── contains_ignore_case ────────────────────────────────────────────────
    // Moved here verbatim with the function itself (it was `mcp_bridge::respond`'s).
    // h_query's message filter used to lowercase the whole raw line on every
    // scanned line; contains_ignore_case must match the exact same lines
    // without that per-line allocation.

    #[test]
    fn contains_ignore_case_matches_mixed_case_ascii() {
        let needle = "error".to_lowercase();
        assert!(contains_ignore_case("System ERROR: boot failed", &needle));
        assert!(contains_ignore_case("system error: boot failed", &needle));
        assert!(contains_ignore_case("SyStEm ErRoR: boot failed", &needle));
        assert!(!contains_ignore_case("System is fine", &needle));
    }

    #[test]
    fn contains_ignore_case_matches_original_to_lowercase_semantics() {
        // Cross-check against the original `haystack.to_lowercase().contains(needle)`
        // behavior for a battery of mixed-case ASCII lines.
        let cases: &[(&str, &str, bool)] = &[
            ("ActivityManager: Process died", "process", true),
            ("ActivityManager: Process died", "PROCESS", true),
            ("no match here", "xyz", false),
            ("", "a", false),
            ("anything", "", true),
            ("EdgeCaseAtEnd", "atend", true),
            ("EdgeCaseAtEnd", "ATEND", true),
        ];
        for &(haystack, needle, expected) in cases {
            let needle_lower = needle.to_lowercase();
            assert_eq!(
                contains_ignore_case(haystack, &needle_lower),
                expected,
                "haystack={haystack:?} needle={needle:?}"
            );
            assert_eq!(
                contains_ignore_case(haystack, &needle_lower),
                haystack.to_lowercase().contains(&needle_lower),
                "mismatch vs to_lowercase().contains() for haystack={haystack:?} needle={needle:?}"
            );
        }
    }

    #[test]
    fn contains_ignore_case_falls_back_for_non_ascii_haystack() {
        // Non-ASCII haystack takes the allocating fallback path — verify it
        // still matches Unicode-aware `to_lowercase()` semantics exactly.
        let needle = "CAFÉ".to_lowercase();
        assert!(contains_ignore_case("visit the café today", &needle));
        assert!(!contains_ignore_case("visit the cafe today", &needle));
    }

    // ── level_at_least ──────────────────────────────────────────────────────

    #[test]
    fn level_at_least_orders_by_severity() {
        assert!(level_at_least("E", "W"));
        assert!(level_at_least("W", "W"));
        assert!(!level_at_least("D", "W"));
        // Unknown levels are treated as Info, on both sides.
        assert!(level_at_least("?", "D"));
        assert!(!level_at_least("?", "W"));
    }

    // ── Metadata source ─────────────────────────────────────────────────────

    #[test]
    fn indexed_metadata_never_consults_the_parser() {
        // A logcat-shaped line: `Parsed` splits out pid/tid and a message
        // distinct from `raw`, `Indexed` reports the stored meta and leaves
        // `message == raw`. Both keep `raw` byte-identical.
        let line = "01-15 10:30:00.000  1234  5678 E MyTag: something failed";
        let session = fixture_session_from("s1", vec![line.to_string()]);
        let (ctx, _tmp) = test_ctx().with_session_object(session).build();

        let parsed = get_lines(&ctx, LinesRequest::range("s1", 0, 1)).unwrap();
        assert_eq!(parsed.lines[0].tag, "MyTag");
        assert_eq!(parsed.lines[0].pid, 1234);
        assert_ne!(parsed.lines[0].message, parsed.lines[0].raw);

        let mut req = LinesRequest::range("s1", 0, 1);
        req.metadata = LineMetadataSource::Indexed;
        let indexed = get_lines(&ctx, req).unwrap();
        // The fixture writes its own `LineMeta` (Info, tag 0) rather than
        // running `parse_meta`, which is exactly the point: `Indexed` reports
        // what was stored at index time, whatever that was.
        assert_eq!(indexed.lines[0].tag, "");
        assert_eq!(indexed.lines[0].level, LogLevel::Info);
        assert_eq!(indexed.lines[0].pid, 0);
        assert_eq!(indexed.lines[0].message, indexed.lines[0].raw);
        assert_eq!(indexed.lines[0].raw, parsed.lines[0].raw);
    }
}
