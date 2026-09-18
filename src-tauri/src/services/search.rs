//! `search` — the one implementation of "find lines matching a pattern".
//!
//! Before this file existed there were three, all scanning the same
//! `LogSource` through the same `sessions` lock and disagreeing about almost
//! everything else:
//!
//! - `commands::files::search_logs` — the viewer's counting search. Returns
//!   *no* text at all: line numbers plus level/tag histograms, streamed to the
//!   UI as `search-progress` events so the match list fills in while the scan
//!   runs. Uncapped: the viewer is entitled to scan its whole file.
//! - `mcp_bridge::routes::search::h_search` — regex hits with capture groups
//!   and optional context, stopping as soon as it has `limit` of them.
//! - `h_search_with_context` — the same scan, but it keeps going past the page
//!   to report an exact match count, and renders context as one flat list.
//!
//! [`summary`] is the first; [`hits`] is the second and third. The three
//! endpoints keep their wire shapes — the transports render them — but there
//! is now one scan, one redaction choke point and one set of scan bounds.
//!
//! ## Redaction
//!
//! [`hits`] puts every returned line through
//! [`lines::redact_view_lines`](crate::services::lines::redact_view_lines)
//! *after* the `sessions` lock has been dropped: anonymize first, truncate
//! second, one anonymizer lock per page. Matching itself is on raw text — an
//! `Internal`-pathway caller under anonymizer mode `All` finds an email by
//! searching for it and sees the hit as `<EMAIL-1>`.
//! [`summary`] returns no line text, so there is nothing to redact — only line
//! numbers, level names and tags.
//!
//! ## Locking
//!
//! One `AppState` lock at a time, never across an `.await`. Both functions are
//! synchronous by contract (the transports wrap them in `spawn_blocking`) and
//! re-acquire `sessions` once per [`MCP_SCAN_CHUNK_SIZE`] lines rather than
//! holding it for the whole scan. `raw_line`/`meta_at` are used throughout —
//! never direct indexing — so a stream source's eviction offset applies.

use std::collections::HashMap;
use std::sync::Arc;

use regex::Regex;

use crate::core::line::{LogLevel, SearchQuery, SearchSummary, ViewLine};
use crate::core::log_source::LogSource;
use crate::core::session::AnalysisSession;
use crate::services::events::{ProgressEvent, ProgressSink, SearchProgressEvent};
use crate::services::lines::{
    MCP_SCAN_CHUNK_SIZE, MCP_SCAN_LINE_CAP, NO_SOURCES, capped_range_end, contains_ignore_case,
    scan_chunk_bounds, scan_window_capped,
};
use crate::services::lines::redact_view_lines;
use crate::services::wire::{SearchHit, SearchHits};
use crate::services::{ServiceCtx, ServiceError, lock_svc};

/// [`ServiceError::InvalidArg`] code for a pattern `regex` refused to compile.
/// Distinct from the generic `INVALID_ARGUMENT` so an adapter can tell a bad
/// pattern from a session with no sources without matching on message text.
pub const INVALID_REGEX: &str = "INVALID_REGEX";

/// Nanoseconds in a 24-hour day — the modulus [`summary`]'s time-of-day
/// filter compares against.
const DAY_NS: i64 = 86_400_000_000_000;

/// Parse `"HH:MM"` or `"HH:MM:SS"` into nanoseconds within a 24-hour day.
/// Returns `None` on invalid input, which the caller treats as "no bound" —
/// an unparseable filter has always been ignored rather than rejected.
///
/// Moved here verbatim from `commands::files`, whose `search_logs` was its
/// only caller.
fn parse_time_to_day_ns(s: &str) -> Option<i64> {
    let mut parts = s.splitn(3, ':');
    let h: i64 = parts.next()?.trim().parse().ok()?;
    let m: i64 = parts.next()?.trim().parse().ok()?;
    let sec: i64 = parts
        .next()
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    if !(0..=23).contains(&h) || !(0..=59).contains(&m) || !(0..=59).contains(&sec) {
        return None;
    }
    Some((h * 3600 + m * 60 + sec) * 1_000_000_000)
}

// ---------------------------------------------------------------------------
// summary — the counting search
// ---------------------------------------------------------------------------

/// Count the lines matching `query` and bucket them by level and tag.
///
/// Returns no line text: the viewer already has the lines, it wants to know
/// *which* ones matched. Progress is reported once per
/// [`MCP_SCAN_CHUNK_SIZE`]-line chunk and once more with `done: true` at the
/// end, carrying that chunk's new match line numbers so the UI can fill its
/// match list incrementally instead of waiting for the whole scan.
///
/// Deliberately **uncapped** — unlike [`hits`], which applies
/// [`MCP_SCAN_LINE_CAP`]. This is a local user searching their own open file
/// and a partial answer would be a wrong answer; the chunked lock release is
/// what keeps it from starving the rest of the app.
///
/// Synchronous by contract: it takes the `sessions` lock once per chunk and
/// must never hold one across an await, so async callers run it on the
/// blocking pool. (That pool is also what the old handler's `yield_now()`
/// between chunks was approximating.)
pub fn summary(
    ctx: &ServiceCtx,
    session_id: &str,
    query: &SearchQuery,
    progress: Arc<dyn ProgressSink>,
) -> Result<SearchSummary, ServiceError> {
    // Resolve the session first, before compiling the pattern: an unknown
    // session and an invalid regex together have always reported the session.
    let total_lines = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| ServiceError::session_not_found(session_id))?;
        let source = session
            .primary_source()
            .ok_or_else(|| ServiceError::invalid_arg(NO_SOURCES))?;
        source.total_lines()
    };

    let compiled_re = if query.is_regex {
        let pattern = if query.case_sensitive {
            query.text.clone()
        } else {
            format!("(?i){}", query.text)
        };
        Some(Regex::new(&pattern).map_err(|e| ServiceError::InvalidArg {
            code: INVALID_REGEX,
            message: format!("Invalid regex: {e}"),
        })?)
    } else {
        None
    };

    let needle_lower = query.text.to_lowercase();

    // Time-of-day bounds, in nanoseconds since midnight. An unparseable bound
    // is simply absent (see `parse_time_to_day_ns`).
    let start_ns = query.start_time.as_deref().and_then(parse_time_to_day_ns);
    let end_ns = query.end_time.as_deref().and_then(parse_time_to_day_ns);
    let has_time_filter = start_ns.is_some() || end_ns.is_some();

    let mut match_line_nums: Vec<usize> = Vec::new();
    let mut by_level: HashMap<String, usize> = HashMap::new();
    let mut by_tag: HashMap<String, usize> = HashMap::new();

    for (chunk_start, chunk_end) in scan_chunk_bounds(0, total_lines, MCP_SCAN_CHUNK_SIZE) {
        let mut chunk_matches: Vec<usize> = Vec::new();

        {
            // `sessions` guard scope — dropped before the progress emit below,
            // which is a foreign callback and must not run under our lock.
            let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| ServiceError::session_not_found(session_id))?;
            let source = session
                .primary_source()
                .ok_or_else(|| ServiceError::invalid_arg(NO_SOURCES))?;

            for i in chunk_start..chunk_end {
                let Some(meta) = source.meta_at(i) else {
                    continue;
                };

                if let Some(min_level) = query.min_level {
                    if meta.level < min_level {
                        continue;
                    }
                }

                if let Some(ref tags) = query.tags {
                    let tag_str = session.resolve_tag(meta.tag_id);
                    if !tags.is_empty() && !tags.iter().any(|t| t == tag_str) {
                        continue;
                    }
                }

                if has_time_filter {
                    // A line with no timestamp cannot satisfy a time bound.
                    if meta.timestamp == 0 {
                        continue;
                    }
                    let ts_mod = meta.timestamp % DAY_NS;
                    if let Some(s) = start_ns {
                        if ts_mod < s {
                            continue;
                        }
                    }
                    if let Some(e) = end_ns {
                        if ts_mod > e {
                            continue;
                        }
                    }
                }

                let raw_cow = source.raw_line(i);
                let raw = raw_cow.as_deref().unwrap_or("");
                let matched = match compiled_re {
                    Some(ref re) => re.is_match(raw),
                    None if query.case_sensitive => raw.contains(query.text.as_str()),
                    // `contains_ignore_case` is the allocation-free twin of
                    // `raw.to_lowercase().contains(&needle_lower)` for ASCII
                    // input and falls back to exactly that otherwise.
                    None => contains_ignore_case(raw, &needle_lower),
                };

                if matched {
                    chunk_matches.push(i);
                    *by_level.entry(format!("{:?}", meta.level)).or_insert(0) += 1;
                    let tag_str = session.resolve_tag(meta.tag_id);
                    if !tag_str.is_empty() {
                        *by_tag.entry(tag_str.to_string()).or_insert(0) += 1;
                    }
                }
            }
        } // lock released

        match_line_nums.extend_from_slice(&chunk_matches);

        progress.on_progress(&ProgressEvent::Search(SearchProgressEvent {
            session_id: session_id.to_string(),
            matched_so_far: match_line_nums.len(),
            lines_scanned: chunk_end,
            total_lines,
            new_matches: chunk_matches,
            done: false,
        }));
    }

    progress.on_progress(&ProgressEvent::Search(SearchProgressEvent {
        session_id: session_id.to_string(),
        matched_so_far: match_line_nums.len(),
        lines_scanned: total_lines,
        total_lines,
        new_matches: vec![],
        done: true,
    }));

    Ok(SearchSummary {
        total_matches: match_line_nums.len(),
        match_line_nums,
        by_level,
        by_tag,
    })
}

// ---------------------------------------------------------------------------
// hits — the text-returning search
// ---------------------------------------------------------------------------

/// One request for matching lines and their surroundings.
///
/// The last three fields exist only to reproduce, exactly, two endpoints that
/// were written independently and differ in ways nobody chose. They are
/// transitional: WP-13 picks one behaviour per field and deletes them.
#[derive(Debug, Clone)]
pub struct SearchHitsRequest {
    pub session_id: String,
    /// Regex source, as the caller wrote it. `case_insensitive` is applied by
    /// prefixing `(?i)`, so an inline flag in the pattern still works.
    pub pattern: String,
    pub case_insensitive: bool,
    /// Lines of context to collect before each match.
    pub context_before: usize,
    /// Lines of context to collect after each match.
    pub context_after: usize,
    /// Matches to skip before collecting this page.
    pub offset: usize,
    /// Maximum hits to collect.
    pub limit: usize,
    /// Restrict the scan to lines >= this index (0-based, inclusive).
    pub start_line: Option<usize>,
    /// Restrict the scan to lines < this index (0-based, exclusive).
    pub end_line: Option<usize>,
    /// Per-line character cap, applied *after* anonymization.
    pub max_line_chars: usize,
    /// Collect regex capture groups for each hit (`search`), rather than a
    /// membership test (`search_with_context`, which never returned them).
    pub with_captures: bool,
    /// Keep scanning past a full page so
    /// [`SearchHits::total`](crate::services::wire::SearchHits::total) is an
    /// exact count of the range (`search_with_context`), rather than stopping
    /// at `limit` (`search`).
    ///
    /// Also decides what `truncated` means: a scan that stopped because the
    /// page was full was not cut short by the scan cap, so `search` reports
    /// the cap only when it came up short.
    pub count_all_matches: bool,
    /// Count a line whose raw text could not be read — evicted from a stream
    /// buffer with no spill — toward `scannedLines`.
    ///
    /// Transitional: `search` counts it, `search_with_context` does not, and
    /// this is the only fact that distinguishes their two counters.
    pub count_unreadable_as_scanned: bool,
    /// Redact the matching line before its context lines.
    ///
    /// Transitional, and only observable through anonymizer token *numbering*:
    /// the per-session anonymizer assigns tokens in first-seen order, so
    /// `search` (which redacted the match, then the context) and
    /// `search_with_context` (which redacted one flat list in reading order)
    /// number a context line's PII differently. Redaction itself is identical
    /// either way.
    pub redact_match_line_first: bool,
}

/// Find lines matching `req.pattern`, with context, paginated.
///
/// Synchronous by contract — see [`summary`].
///
/// Bounded by [`MCP_SCAN_LINE_CAP`]: a rarely-matching regex over a
/// multi-million-line bugreport would otherwise run for as long as it takes.
/// A caller that needs to see past the cap pages with `start_line`/`end_line`.
pub fn hits(ctx: &ServiceCtx, req: &SearchHitsRequest) -> Result<SearchHits, ServiceError> {
    // Compile before resolving the session: both endpoints have always
    // reported a bad pattern even for a session that does not exist.
    let pattern = if req.case_insensitive {
        format!("(?i){}", req.pattern)
    } else {
        req.pattern.clone()
    };
    let regex = Regex::new(&pattern).map_err(|e| ServiceError::InvalidArg {
        code: INVALID_REGEX,
        message: e.to_string(),
    })?;

    let total: usize = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        let session = sessions
            .get(&req.session_id)
            .ok_or_else(|| ServiceError::session_not_found(&req.session_id))?;
        let source = session
            .primary_source()
            .ok_or_else(|| ServiceError::invalid_arg(NO_SOURCES))?;
        source.total_lines()
    };

    let range_start = req.start_line.unwrap_or(0).min(total);
    let requested_end = req.end_line.unwrap_or(total).min(total);
    let cap_applied = scan_window_capped(range_start, requested_end, MCP_SCAN_LINE_CAP);
    let range_end = capped_range_end(range_start, requested_end, MCP_SCAN_LINE_CAP);

    let mut collected: Vec<SearchHit> = Vec::new();
    let mut total_matches: usize = 0;
    let mut skipped: usize = 0;
    let mut lines_scanned: usize = 0;
    let mut session_lost = false;

    'chunks: for (chunk_start, chunk_end) in
        scan_chunk_bounds(range_start, range_end, MCP_SCAN_CHUNK_SIZE)
    {
        if !req.count_all_matches && collected.len() >= req.limit {
            break;
        }

        {
            // `sessions` guard scope. Every string collected here is RAW;
            // `redact_view_lines` takes the anonymizer's own locks and must
            // not be called while `sessions` is held.
            let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
            // A session removed mid-scan is not an error — it truncates the
            // results, which is what `truncated` is for.
            let Some(session) = sessions.get(&req.session_id) else {
                session_lost = true;
                break 'chunks;
            };
            let Some(source) = session.primary_source() else {
                session_lost = true;
                break 'chunks;
            };
            // `total_lines` on a live stream only ever grows (eviction shifts
            // the retained window, not the count), but clamp defensively
            // rather than assume that invariant here.
            let live_total = source.total_lines();
            let chunk_end = chunk_end.min(live_total);

            for i in chunk_start..chunk_end {
                if !req.count_all_matches && collected.len() >= req.limit {
                    break;
                }
                if req.count_unreadable_as_scanned {
                    lines_scanned += 1;
                }
                let Some(raw) = source.raw_line(i) else {
                    continue;
                };
                if !req.count_unreadable_as_scanned {
                    lines_scanned += 1;
                }

                // `captures()` is materially more expensive than `is_match()`,
                // so only the caller that renders capture groups pays for it.
                let captures = if req.with_captures {
                    match regex.captures(&raw) {
                        Some(caps) => (1..caps.len())
                            .filter_map(|j| caps.get(j).map(|m| m.as_str().to_string()))
                            .collect(),
                        None => continue,
                    }
                } else {
                    if !regex.is_match(&raw) {
                        continue;
                    }
                    Vec::new()
                };

                total_matches += 1;

                if skipped < req.offset {
                    skipped += 1;
                    continue;
                }
                // Only reachable on the counting path — the other one has
                // already broken out of the loop.
                if collected.len() >= req.limit {
                    continue;
                }

                // Context windows are relative to the match, not to the scan
                // range: a match at the edge of an explicit `start_line`
                // window still shows what precedes it.
                let before_start = i.saturating_sub(req.context_before);
                let context_before: Vec<ViewLine> = (before_start..i)
                    .filter_map(|j| view_line(session, source, j, true))
                    .collect();
                let after_end = i
                    .saturating_add(1)
                    .saturating_add(req.context_after)
                    .min(live_total);
                let context_after: Vec<ViewLine> = ((i + 1)..after_end)
                    .filter_map(|j| view_line(session, source, j, true))
                    .collect();

                collected.push(SearchHit {
                    line: indexed_view_line(session, source, i, raw.into_owned(), false),
                    context_before,
                    context_after,
                    captures,
                });
            }
        } // lock released
    }

    // A scan that stopped because the page was full was not cut short by the
    // cap — there may be nothing past it. A counting scan covers the whole
    // range by construction, so for it the cap alone is the truncation.
    let truncated = session_lost
        || if req.count_all_matches {
            cap_applied
        } else {
            cap_applied && collected.len() < req.limit
        };

    // Redaction happens here, after the last `sessions` acquisition above has
    // been released — anonymize first, truncate second, one anonymizer lock
    // for the whole page (`redact_view_lines`). The lines are handed over in
    // the order `redact_match_line_first` dictates, because token numbering
    // follows first sight.
    let ordered = collected.iter_mut().flat_map(|hit| {
        let SearchHit { line, context_before, context_after, .. } = hit;
        let (first, second) = if req.redact_match_line_first {
            (Some(line), None)
        } else {
            (None, Some(line))
        };
        first
            .into_iter()
            .chain(context_before.iter_mut())
            .chain(second)
            .chain(context_after.iter_mut())
    });
    redact_view_lines(ctx, &req.session_id, ordered, req.max_line_chars, None);

    Ok(SearchHits {
        session_id: req.session_id.clone(),
        total: total_matches,
        returned: collected.len(),
        offset: req.offset,
        limit: req.limit,
        truncated,
        scanned_lines: lines_scanned,
        total_lines: total,
        hits: collected,
    })
}

// ---------------------------------------------------------------------------
// ViewLine construction
// ---------------------------------------------------------------------------

/// Build one [`ViewLine`] from the stored [`LineMeta`](crate::core::line::LineMeta),
/// returning `None` when the raw text cannot be read.
///
/// The parser is deliberately not consulted — this is
/// [`LineMetadataSource::Indexed`](crate::services::lines::LineMetadataSource::Indexed)
/// in `services::lines`' vocabulary, which is the view both search endpoints
/// have always served. (`lines::build_view_line` is private to that module and
/// takes a `LogParser` this path has no use for, so the indexed half is
/// reproduced here rather than widened there.)
fn view_line(
    session: &AnalysisSession,
    source: &dyn LogSource,
    line_num: usize,
    is_context: bool,
) -> Option<ViewLine> {
    let raw = source.raw_line(line_num)?.into_owned();
    Some(indexed_view_line(session, source, line_num, raw, is_context))
}

/// [`view_line`] for a caller that already holds the raw text.
fn indexed_view_line(
    session: &AnalysisSession,
    source: &dyn LogSource,
    line_num: usize,
    raw: String,
    is_context: bool,
) -> ViewLine {
    let meta = source.meta_at(line_num);
    ViewLine {
        line_num,
        // Search results are addressed by absolute line number; there is no
        // enclosing virtual window for this to index into.
        virtual_index: line_num,
        level: meta.map_or(LogLevel::Info, |m| m.level),
        tag: meta.map_or_else(String::new, |m| session.resolve_tag(m.tag_id).to_string()),
        message: raw.clone(),
        timestamp: meta.map_or(0, |m| m.timestamp),
        pid: 0,
        tid: 0,
        source_id: source.id().to_string(),
        // Highlight spans would be byte offsets into the pre-redaction text.
        highlights: Vec::new(),
        matched_by: Vec::new(),
        is_context,
        raw,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::AppState;
    use crate::core::line::LogLevel;
    use crate::services::testing::{RecordingSink, fixture_session, fixture_session_with_pii, test_ctx};
    use crate::services::{Caller, NullProgressSink};

    // ── The golden reference ────────────────────────────────────────────────
    //
    // `ref_search_logs` is the pre-service body of `commands::files::search_logs`,
    // copied from commit dc3f4b2 and frozen, with exactly one change: it
    // collects the progress payloads it would have emitted instead of calling
    // `app_handle.emit`, since a frozen copy must not need an `AppHandle`.
    // The scan, the filters, the histograms and the progress cadence are
    // untouched.
    //
    // Pinning against a frozen implementation rather than a checked-in JSON
    // blob is deliberate (same rationale as `routes/lines.rs`): a snapshot
    // pins the inputs someone thought to capture, this diffs the whole result
    // over a case table. If a case fails, the new code is wrong, not this copy.

    /// The `search-progress` payload, as a comparable tuple.
    type ProgressSnap = (usize, usize, usize, Vec<usize>, bool);

    const REF_SEARCH_CHUNK_SIZE: usize = 10_000;

    fn ref_parse_time_to_day_ns(s: &str) -> Option<i64> {
        let mut parts = s.splitn(3, ':');
        let h: i64 = parts.next()?.trim().parse().ok()?;
        let m: i64 = parts.next()?.trim().parse().ok()?;
        let sec: i64 = parts
            .next()
            .and_then(|s| s.split('.').next())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        if !(0..=23).contains(&h) || !(0..=59).contains(&m) || !(0..=59).contains(&sec) {
            return None;
        }
        Some((h * 3600 + m * 60 + sec) * 1_000_000_000)
    }

    /// Frozen copy of the pre-service `search_logs` body.
    #[allow(clippy::type_complexity)]
    fn ref_search_logs(
        state: &AppState,
        session_id: &str,
        query: &SearchQuery,
    ) -> Result<(SearchSummary, Vec<ProgressSnap>), String> {
        let mut emitted: Vec<ProgressSnap> = Vec::new();

        let total_lines = {
            let sessions = state
                .sessions
                .lock()
                .map_err(|_| "sessions lock poisoned".to_string())?;
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("Session '{session_id}' not found"))?;
            let source = session.primary_source().ok_or("No sources in session")?;
            source.total_lines()
        };

        let compiled_re = if query.is_regex {
            let pattern = if query.case_sensitive {
                query.text.clone()
            } else {
                format!("(?i){}", query.text)
            };
            Some(Regex::new(&pattern).map_err(|e| format!("Invalid regex: {e}"))?)
        } else {
            None
        };

        let needle_lower = query.text.to_lowercase();

        const DAY_NS: i64 = 86_400_000_000_000;
        let start_ns = query.start_time.as_deref().and_then(ref_parse_time_to_day_ns);
        let end_ns = query.end_time.as_deref().and_then(ref_parse_time_to_day_ns);
        let has_time_filter = start_ns.is_some() || end_ns.is_some();

        let mut match_line_nums: Vec<usize> = Vec::new();
        let mut by_level: HashMap<String, usize> = HashMap::new();
        let mut by_tag: HashMap<String, usize> = HashMap::new();

        let mut chunk_start = 0;
        while chunk_start < total_lines {
            let chunk_end = (chunk_start + REF_SEARCH_CHUNK_SIZE).min(total_lines);
            let mut chunk_matches: Vec<usize> = Vec::new();

            {
                let sessions = state
                    .sessions
                    .lock()
                    .map_err(|_| "sessions lock poisoned".to_string())?;
                let session = sessions
                    .get(session_id)
                    .ok_or_else(|| format!("Session '{session_id}' not found"))?;
                let source = session.primary_source().ok_or("No sources in session")?;

                for i in chunk_start..chunk_end {
                    let Some(meta) = source.meta_at(i) else {
                        continue;
                    };

                    if let Some(min_level) = query.min_level {
                        if meta.level < min_level {
                            continue;
                        }
                    }

                    if let Some(ref tags) = query.tags {
                        let tag_str = session.resolve_tag(meta.tag_id);
                        if !tags.is_empty() && !tags.iter().any(|t| t == tag_str) {
                            continue;
                        }
                    }

                    if has_time_filter {
                        if meta.timestamp == 0 {
                            continue;
                        }
                        let ts_mod = meta.timestamp % DAY_NS;
                        if let Some(s) = start_ns {
                            if ts_mod < s {
                                continue;
                            }
                        }
                        if let Some(e) = end_ns {
                            if ts_mod > e {
                                continue;
                            }
                        }
                    }

                    let raw_cow = source.raw_line(i);
                    let raw = raw_cow.as_deref().unwrap_or("");
                    let matched = if let Some(ref re) = compiled_re {
                        re.is_match(raw)
                    } else if query.case_sensitive {
                        raw.contains(query.text.as_str())
                    } else {
                        raw.to_lowercase().contains(&needle_lower)
                    };

                    if matched {
                        chunk_matches.push(i);
                        *by_level.entry(format!("{:?}", meta.level)).or_insert(0) += 1;
                        let tag_str = session.resolve_tag(meta.tag_id);
                        if !tag_str.is_empty() {
                            *by_tag.entry(tag_str.to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }

            match_line_nums.extend_from_slice(&chunk_matches);

            emitted.push((
                match_line_nums.len(),
                chunk_end,
                total_lines,
                chunk_matches,
                false,
            ));

            chunk_start = chunk_end;
        }

        emitted.push((match_line_nums.len(), total_lines, total_lines, vec![], true));

        Ok((
            SearchSummary {
                total_matches: match_line_nums.len(),
                match_line_nums,
                by_level,
                by_tag,
            },
            emitted,
        ))
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    fn ctx_with_fixtures() -> (ServiceCtx, tempfile::TempDir) {
        test_ctx()
            .caller(Caller::Ui)
            .with_session_object(fixture_session("s1", 200))
            // Spans three chunk boundaries, so the progress cadence and the
            // per-chunk re-lock are actually exercised.
            .with_session_object(fixture_session("big", 25_000))
            .with_session_object(fixture_session("empty", 0))
            .build()
    }

    fn q(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.to_string(),
            is_regex: false,
            case_sensitive: true,
            within_processor: None,
            min_level: None,
            tags: None,
            start_time: None,
            end_time: None,
        }
    }

    /// Drain a [`RecordingSink`]'s search progress events into the comparable
    /// tuple the frozen reference produces.
    fn progress_snaps(sink: &RecordingSink) -> Vec<ProgressSnap> {
        sink.progress_events()
            .into_iter()
            .filter_map(|ev| match ev {
                ProgressEvent::Search(p) => Some((
                    p.matched_so_far,
                    p.lines_scanned,
                    p.total_lines,
                    p.new_matches,
                    p.done,
                )),
                _ => None,
            })
            .collect()
    }

    // ── summary parity ──────────────────────────────────────────────────────

    #[test]
    fn summary_matches_the_frozen_search_logs_across_queries() {
        let cases: Vec<(&str, &str, SearchQuery)> = vec![
            ("plain substring", "s1", q("line 1")),
            ("substring matching nothing", "s1", q("no-such-text")),
            (
                "case-insensitive substring",
                "s1",
                SearchQuery {
                    case_sensitive: false,
                    ..q("LINE 4")
                },
            ),
            (
                "case-sensitive substring misses",
                "s1",
                q("LINE 4"),
            ),
            (
                "regex with alternation",
                "s1",
                SearchQuery {
                    is_regex: true,
                    ..q(r"line (7|8)$")
                },
            ),
            (
                "case-insensitive regex",
                "s1",
                SearchQuery {
                    is_regex: true,
                    case_sensitive: false,
                    ..q(r"LINE \d\d$")
                },
            ),
            (
                "level filter above every line",
                "s1",
                SearchQuery {
                    min_level: Some(LogLevel::Warn),
                    ..q("line")
                },
            ),
            (
                "level filter at the line level",
                "s1",
                SearchQuery {
                    min_level: Some(LogLevel::Info),
                    ..q("line")
                },
            ),
            (
                "tag filter, empty list matches everything",
                "s1",
                SearchQuery {
                    tags: Some(vec![]),
                    ..q("line")
                },
            ),
            (
                "tag filter, no match",
                "s1",
                SearchQuery {
                    tags: Some(vec!["Nope".into()]),
                    ..q("line")
                },
            ),
            (
                "time filter, lower bound only",
                "s1",
                SearchQuery {
                    start_time: Some("00:00:01".into()),
                    ..q("line")
                },
            ),
            (
                "time filter, both bounds",
                "s1",
                SearchQuery {
                    start_time: Some("00:00:01".into()),
                    end_time: Some("00:00:01".into()),
                    ..q("line")
                },
            ),
            (
                "time filter, unparseable bound is ignored",
                "s1",
                SearchQuery {
                    start_time: Some("not-a-time".into()),
                    ..q("line")
                },
            ),
            ("empty session", "empty", q("anything")),
            ("multi-chunk scan", "big", q("line 1999")),
            ("multi-chunk scan, no matches", "big", q("zzz")),
        ];

        for (name, session_id, query) in cases {
            let (ref_ctx, _t1) = ctx_with_fixtures();
            let (new_ctx, sink, _t2) = test_ctx()
                .caller(Caller::Ui)
                .with_session_object(fixture_session("s1", 200))
                .with_session_object(fixture_session("big", 25_000))
                .with_session_object(fixture_session("empty", 0))
                .build_recording();

            let (expected, expected_progress) =
                ref_search_logs(ref_ctx.state(), session_id, &query).expect(name);
            let actual = summary(
                &new_ctx,
                session_id,
                &query,
                Arc::clone(&sink) as Arc<dyn ProgressSink>,
            )
            .expect(name);

            assert_eq!(
                actual.total_matches, expected.total_matches,
                "total_matches changed for case: {name}"
            );
            assert_eq!(
                actual.match_line_nums, expected.match_line_nums,
                "match_line_nums changed for case: {name}"
            );
            assert_eq!(
                actual.by_level, expected.by_level,
                "by_level changed for case: {name}"
            );
            assert_eq!(
                actual.by_tag, expected.by_tag,
                "by_tag changed for case: {name}"
            );
            assert_eq!(
                progress_snaps(&sink),
                expected_progress,
                "search-progress cadence changed for case: {name}"
            );
        }
    }

    #[test]
    fn summary_emits_one_progress_event_per_chunk_plus_a_final_done() {
        let (ctx, sink, _t) = test_ctx()
            .caller(Caller::Ui)
            .with_session_object(fixture_session("big", 25_000))
            .build_recording();

        summary(
            &ctx,
            "big",
            &q("line 1"),
            Arc::clone(&sink) as Arc<dyn ProgressSink>,
        )
        .unwrap();

        let snaps = progress_snaps(&sink);
        // 25_000 lines at MCP_SCAN_CHUNK_SIZE = 10_000 -> 3 chunks, + done.
        assert_eq!(snaps.len(), 4);
        assert_eq!(
            snaps.iter().map(|s| s.1).collect::<Vec<_>>(),
            vec![10_000, 20_000, 25_000, 25_000]
        );
        assert_eq!(
            snaps.iter().map(|s| s.4).collect::<Vec<_>>(),
            vec![false, false, false, true]
        );
    }

    #[test]
    fn summary_on_an_empty_session_still_emits_the_done_event() {
        let (ctx, sink, _t) = test_ctx()
            .caller(Caller::Ui)
            .with_session_object(fixture_session("empty", 0))
            .build_recording();

        let out = summary(
            &ctx,
            "empty",
            &q("x"),
            Arc::clone(&sink) as Arc<dyn ProgressSink>,
        )
        .unwrap();
        assert_eq!(out.total_matches, 0);
        assert_eq!(progress_snaps(&sink), vec![(0, 0, 0, vec![], true)]);
    }

    #[test]
    fn summary_reports_the_sessions_historical_error_messages() {
        let (ctx, _t) = ctx_with_fixtures();

        let err = summary(&ctx, "nope", &q("x"), Arc::new(NullProgressSink)).unwrap_err();
        assert_eq!(err.message(), "Session 'nope' not found");

        let bad = SearchQuery {
            is_regex: true,
            ..q("(unclosed")
        };
        let err = summary(&ctx, "s1", &bad, Arc::new(NullProgressSink)).unwrap_err();
        assert!(
            err.message().starts_with("Invalid regex: "),
            "got {}",
            err.message()
        );
        assert_eq!(err.code(), INVALID_REGEX);
    }

    #[test]
    fn summary_reports_an_unknown_session_before_an_invalid_pattern() {
        // Order matters: `search_logs` resolved the session first, so a caller
        // with both problems has always been told about the session.
        let (ctx, _t) = ctx_with_fixtures();
        let bad = SearchQuery {
            is_regex: true,
            ..q("(unclosed")
        };
        let err = summary(&ctx, "nope", &bad, Arc::new(NullProgressSink)).unwrap_err();
        assert_eq!(err.message(), "Session 'nope' not found");
    }

    // ── hits ────────────────────────────────────────────────────────────────

    /// `h_search`'s knob settings.
    fn scan_req(session_id: &str, pattern: &str) -> SearchHitsRequest {
        SearchHitsRequest {
            session_id: session_id.to_string(),
            pattern: pattern.to_string(),
            case_insensitive: false,
            context_before: 0,
            context_after: 0,
            offset: 0,
            limit: 50,
            start_line: None,
            end_line: None,
            max_line_chars: 500,
            with_captures: true,
            count_all_matches: false,
            count_unreadable_as_scanned: true,
            redact_match_line_first: true,
        }
    }

    /// `h_search_with_context`'s knob settings.
    fn count_req(session_id: &str, pattern: &str) -> SearchHitsRequest {
        SearchHitsRequest {
            context_before: 3,
            context_after: 3,
            limit: 10,
            with_captures: false,
            count_all_matches: true,
            count_unreadable_as_scanned: false,
            redact_match_line_first: false,
            ..scan_req(session_id, pattern)
        }
    }

    #[test]
    fn hits_returns_the_matching_lines_with_captures() {
        let (ctx, _t) = ctx_with_fixtures();
        let out = hits(&ctx, &scan_req("s1", r"^line (1\d)$")).unwrap();

        assert_eq!(out.returned, 10);
        assert_eq!(out.total, 10);
        assert_eq!(out.total_lines, 200);
        assert!(!out.truncated);
        assert_eq!(out.hits[0].line.line_num, 10);
        assert_eq!(out.hits[0].line.raw, "line 10");
        assert_eq!(out.hits[0].captures, vec!["10".to_string()]);
        assert!(!out.hits[0].line.is_context);
    }

    #[test]
    fn hits_collects_context_on_both_sides_and_marks_it() {
        let (ctx, _t) = ctx_with_fixtures();
        let req = SearchHitsRequest {
            context_before: 2,
            context_after: 2,
            ..scan_req("s1", r"^line 50$")
        };
        let out = hits(&ctx, &req).unwrap();

        assert_eq!(out.returned, 1);
        let hit = &out.hits[0];
        assert_eq!(
            hit.context_before
                .iter()
                .map(|l| l.raw.as_str())
                .collect::<Vec<_>>(),
            vec!["line 48", "line 49"]
        );
        assert_eq!(
            hit.context_after
                .iter()
                .map(|l| l.raw.as_str())
                .collect::<Vec<_>>(),
            vec!["line 51", "line 52"]
        );
        assert!(hit.context_before.iter().all(|l| l.is_context));
        assert!(hit.context_after.iter().all(|l| l.is_context));
    }

    #[test]
    fn hits_clamps_context_at_the_file_boundaries() {
        let (ctx, _t) = ctx_with_fixtures();

        let first = hits(
            &ctx,
            &SearchHitsRequest {
                context_before: 5,
                context_after: 5,
                ..scan_req("s1", r"^line 0$")
            },
        )
        .unwrap();
        assert!(first.hits[0].context_before.is_empty());
        assert_eq!(first.hits[0].context_after.len(), 5);

        let last = hits(
            &ctx,
            &SearchHitsRequest {
                context_before: 5,
                context_after: 5,
                ..scan_req("s1", r"^line 199$")
            },
        )
        .unwrap();
        assert_eq!(last.hits[0].context_before.len(), 5);
        assert!(
            last.hits[0].context_after.is_empty(),
            "no lines exist past the end of the log"
        );
    }

    #[test]
    fn hits_stops_at_the_limit_and_reports_that_count_as_total() {
        let (ctx, _t) = ctx_with_fixtures();
        let out = hits(
            &ctx,
            &SearchHitsRequest {
                limit: 5,
                ..scan_req("s1", "line")
            },
        )
        .unwrap();

        assert_eq!(out.returned, 5);
        // The early-stopping scan never learns the true total.
        assert_eq!(out.total, 5);
        assert_eq!(out.scanned_lines, 5);
    }

    #[test]
    fn counting_hits_scan_the_whole_range_for_an_exact_total() {
        let (ctx, _t) = ctx_with_fixtures();
        let out = hits(
            &ctx,
            &SearchHitsRequest {
                limit: 5,
                ..count_req("s1", "line")
            },
        )
        .unwrap();

        assert_eq!(out.returned, 5);
        assert_eq!(out.total, 200);
        assert_eq!(out.scanned_lines, 200);
    }

    #[test]
    fn hits_paginate_with_offset_and_run_off_the_end_cleanly() {
        let (ctx, _t) = ctx_with_fixtures();

        let page2 = hits(
            &ctx,
            &SearchHitsRequest {
                offset: 10,
                limit: 5,
                ..count_req("s1", r"^line \d+$")
            },
        )
        .unwrap();
        assert_eq!(page2.offset, 10);
        assert_eq!(
            page2
                .hits
                .iter()
                .map(|h| h.line.line_num)
                .collect::<Vec<_>>(),
            vec![10, 11, 12, 13, 14]
        );

        let past_end = hits(
            &ctx,
            &SearchHitsRequest {
                offset: 10_000,
                ..count_req("s1", r"^line \d+$")
            },
        )
        .unwrap();
        assert!(past_end.hits.is_empty());
        assert_eq!(past_end.returned, 0);
        // The total is still exact — the page is empty, the scan was not.
        assert_eq!(past_end.total, 200);
        assert!(!past_end.truncated);
    }

    #[test]
    fn hits_honor_the_start_and_end_line_window() {
        let (ctx, _t) = ctx_with_fixtures();
        let out = hits(
            &ctx,
            &SearchHitsRequest {
                start_line: Some(20),
                end_line: Some(30),
                ..count_req("s1", r"^line \d+$")
            },
        )
        .unwrap();

        assert_eq!(out.total, 10);
        assert_eq!(out.scanned_lines, 10);
        assert_eq!(out.hits[0].line.line_num, 20);
        // Total lines is the whole session, not the window.
        assert_eq!(out.total_lines, 200);
    }

    #[test]
    fn hits_are_case_insensitive_on_request() {
        let (ctx, _t) = ctx_with_fixtures();

        let sensitive = hits(&ctx, &scan_req("s1", "LINE 7")).unwrap();
        assert_eq!(sensitive.returned, 0);

        let insensitive = hits(
            &ctx,
            &SearchHitsRequest {
                case_insensitive: true,
                ..scan_req("s1", "LINE 7")
            },
        )
        .unwrap();
        assert!(insensitive.returned > 0);
    }

    #[test]
    fn an_invalid_pattern_is_an_invalid_argument_not_a_panic() {
        let (ctx, _t) = ctx_with_fixtures();
        let err = hits(&ctx, &scan_req("s1", "(unclosed")).unwrap_err();
        assert_eq!(err.code(), INVALID_REGEX);
        assert_eq!(err.http_status(), 400);
        // The raw regex message is carried through for the adapters to frame.
        assert!(err.message().contains("regex"), "got {}", err.message());
    }

    #[test]
    fn an_invalid_pattern_is_reported_before_an_unknown_session() {
        let (ctx, _t) = ctx_with_fixtures();
        let err = hits(&ctx, &scan_req("nope", "(unclosed")).unwrap_err();
        assert_eq!(err.code(), INVALID_REGEX);
    }

    #[test]
    fn hits_report_the_sessions_historical_error_messages() {
        let (ctx, _t) = ctx_with_fixtures();
        let err = hits(&ctx, &scan_req("nope", "line")).unwrap_err();
        assert_eq!(err.message(), "Session 'nope' not found");
        assert_eq!(err.http_status(), 404);
    }

    #[test]
    fn an_empty_session_yields_no_hits() {
        let (ctx, _t) = ctx_with_fixtures();
        let out = hits(&ctx, &count_req("empty", "anything")).unwrap();
        assert_eq!(out.total, 0);
        assert_eq!(out.total_lines, 0);
        assert_eq!(out.scanned_lines, 0);
        assert!(!out.truncated);
    }

    // ── redaction ───────────────────────────────────────────────────────────

    #[test]
    fn an_agent_without_the_anonymize_flag_gets_redacted_text_fail_closed() {
        let (ctx, _t) = test_ctx()
            .agent("mcp")
            .with_session_object(fixture_session_with_pii("p1", 20))
            .build();

        let out = hits(
            &ctx,
            &SearchHitsRequest {
                context_before: 2,
                context_after: 2,
                ..scan_req("p1", "contact")
            },
        )
        .unwrap();

        assert!(out.returned > 0);
        for hit in &out.hits {
            for line in std::iter::once(&hit.line)
                .chain(&hit.context_before)
                .chain(&hit.context_after)
            {
                assert!(
                    !line.raw.contains("@example.com"),
                    "PII survived redaction: {}",
                    line.raw
                );
                assert_eq!(line.message, line.raw, "message must mirror redacted raw");
            }
        }
    }

    #[test]
    fn an_agent_gets_raw_text_only_after_the_user_opted_out() {
        let (ctx, _t) = test_ctx()
            .agent("mcp")
            .with_session_object(fixture_session_with_pii("p1", 20))
            .agent_raw_access(true)
            .build();

        let out = hits(&ctx, &scan_req("p1", "contact")).unwrap();
        assert!(out.hits[0].line.raw.contains("@example.com"));
    }

    #[test]
    fn the_ui_caller_never_anonymizes() {
        let (ctx, _t) = test_ctx()
            .caller(Caller::Ui)
            .with_session_object(fixture_session_with_pii("p1", 20))
            .build();

        let out = hits(&ctx, &scan_req("p1", "contact")).unwrap();
        assert!(out.hits[0].line.raw.contains("@example.com"));
    }

    #[test]
    fn per_line_truncation_applies_after_anonymization() {
        let (ctx, _t) = test_ctx()
            .caller(Caller::Ui)
            .with_session_object(fixture_session("s1", 20))
            .build();

        let out = hits(
            &ctx,
            &SearchHitsRequest {
                max_line_chars: 4,
                ..scan_req("s1", r"^line 12$")
            },
        )
        .unwrap();
        // `truncate_str` keeps `max_chars` characters and marks the cut.
        assert_eq!(out.hits[0].line.raw, "line...");
        assert_eq!(out.hits[0].line.message, out.hits[0].line.raw);
    }

    // ── pure helpers ────────────────────────────────────────────────────────

    #[test]
    fn parse_time_to_day_ns_accepts_hh_mm_and_hh_mm_ss() {
        assert_eq!(parse_time_to_day_ns("00:00"), Some(0));
        assert_eq!(parse_time_to_day_ns("01:00"), Some(3_600_000_000_000));
        assert_eq!(parse_time_to_day_ns("01:02:03"), Some(3_723_000_000_000));
        // Fractional seconds are discarded, not rejected.
        assert_eq!(parse_time_to_day_ns("01:02:03.456"), Some(3_723_000_000_000));
        assert_eq!(parse_time_to_day_ns("23:59:59"), Some(86_399_000_000_000));
    }

    #[test]
    fn parse_time_to_day_ns_rejects_out_of_range_and_garbage() {
        for bad in ["24:00", "12:60", "12:00:60", "noon", "", "12", "-1:00"] {
            assert_eq!(parse_time_to_day_ns(bad), None, "{bad} should not parse");
        }
    }
}
