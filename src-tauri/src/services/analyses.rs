//! Analysis-artifact mutation and listing service.
//!
//! The single implementation of analysis-artifact CRUD, shared by
//! `commands::analysis` (`Caller::Ui`) and `mcp_bridge::routes::artifacts`
//! (`Caller::Agent`). Analyses are workspace-owned (`AppState::analyses`), not
//! session-owned: a single artifact's sections can carry `SourceReference`s
//! that each resolve to a *different* session (or to none, if unattributed).
//!
//! Every mutation: locks `AppState::analyses`, mutates, drops the guard,
//! emits the identical `analysis-update` event both transports' UI listeners
//! already expect, schedules an autosave flush (except restoring a workspace,
//! which must not re-persist itself as a "mutation"), and journals the action.
//!
//! The one read that carries raw log text — the Markdown hand-off export,
//! [`render_markdown`] / [`export_markdown`] — is documented in its own
//! section below ("Markdown hand-off export").

use std::borrow::Cow;

use serde::Deserialize;
use ts_rs::TS;
use uuid::Uuid;

use crate::commands::AppState;
use crate::core::analysis::{
    artifact_references_session, artifact_session_ids, migrate_artifact, AnalysisArtifact,
    AnalysisSection, AnalysisUpdateEvent, Severity,
};
use crate::core::log_source::LogSource;
use crate::workspace::autosave::schedule_autosave;

use super::export::session_display_name;
use super::policy::{self, Pathway};
use super::{lock_svc, ServiceCtx, ServiceError};

/// Publish an analysis artifact, emit `analysis-update` (`published`),
/// schedule an autosave flush, and journal `analysis.publish`.
///
/// `session_id`: `Some(sid)` verifies the session exists (same error message
/// as before) and stamps every unattributed reference in `sections` with
/// `sid` via [`migrate_artifact`]. `None` publishes a workspace-level
/// artifact with no session verification — references keep whatever
/// attribution (if any) the caller already gave them.
pub fn publish(
    ctx: &ServiceCtx,
    session_id: Option<String>,
    title: String,
    sections: Vec<AnalysisSection>,
) -> Result<AnalysisArtifact, ServiceError> {
    if let Some(sid) = &session_id {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        if !sessions.contains_key(sid) {
            return Err(ServiceError::NotFound(format!("Session not found: {sid}")));
        }
    }

    let mut artifact = AnalysisArtifact {
        id: Uuid::new_v4().to_string(),
        title,
        created_at: crate::workspace::now_ms(),
        sections,
        legacy_session_id: None,
    };

    if let Some(sid) = &session_id {
        migrate_artifact(&mut artifact, Some(sid.as_str()));
    }

    {
        let mut analyses = lock_svc(&ctx.state().analyses, "analyses")?;
        analyses.push(artifact.clone());
    }

    ctx.events().emit_json(
        "analysis-update",
        serde_json::to_value(AnalysisUpdateEvent {
            artifact_id: artifact.id.clone(),
            action: "published".to_string(),
            session_ids: artifact_session_ids(&artifact),
            session_id: session_id.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "analysis.publish",
        session_id.as_deref(),
        format!("artifact {}: {}", artifact.id, artifact.title),
    );

    Ok(artifact)
}

/// Pure title/sections-apply step for [`update`]: mutates `art` in place and,
/// when `sections` is replaced, re-runs [`migrate_artifact`] with
/// `fallback_session`. Split out so the fallback-session behavior is directly
/// unit-testable against a plain `AnalysisArtifact` — see [`update`]'s doc
/// comment for what `fallback_session` means.
pub(crate) fn apply_update(
    art: &mut AnalysisArtifact,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
    fallback_session: Option<&str>,
) {
    if let Some(t) = title {
        art.title = t;
    }
    if let Some(s) = sections {
        art.sections = s;
        migrate_artifact(art, fallback_session);
    }
}

/// Update an analysis artifact's title / sections, emit `analysis-update`
/// (`updated`), schedule an autosave flush, and journal `analysis.update`.
/// Looked up by `artifact_id` alone — the workspace-owned store is not keyed
/// by session.
///
/// `fallback_session`: when `sections` is replaced, [`migrate_artifact`]
/// re-runs with this as the fallback. `None` (the workspace route, and the
/// Tauri command) leaves any unattributed reference in the new sections
/// unattributed. `Some(sid)` (the session-SCOPED MCP route only) stamps
/// unattributed references with `sid` instead — this matters for pre-1.3.0
/// MCP clients that PUT to `/mcp/sessions/{session_id}/analyses/{artifact_id}`
/// with references carrying no `sessionId` at all: without this fallback the
/// update would silently de-attribute the artifact from every session,
/// dropping it out of session-scoped lists and `.lts` export.
pub fn update(
    ctx: &ServiceCtx,
    artifact_id: String,
    title: Option<String>,
    sections: Option<Vec<AnalysisSection>>,
    fallback_session: Option<String>,
) -> Result<AnalysisArtifact, ServiceError> {
    let updated = {
        let mut analyses = lock_svc(&ctx.state().analyses, "analyses")?;
        let art = analyses
            .iter_mut()
            .find(|a| a.id == artifact_id)
            .ok_or_else(|| ServiceError::NotFound(format!("Analysis not found: {artifact_id}")))?;

        apply_update(art, title, sections, fallback_session.as_deref());

        art.clone()
    };

    let session_ids = artifact_session_ids(&updated);
    let session_id = session_ids.first().cloned();

    ctx.events().emit_json(
        "analysis-update",
        serde_json::to_value(AnalysisUpdateEvent {
            artifact_id: updated.id.clone(),
            action: "updated".to_string(),
            session_ids,
            session_id: session_id.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "analysis.update",
        session_id.as_deref(),
        format!("artifact {}", updated.id),
    );

    Ok(updated)
}

/// Pure find-and-remove step for [`remove`]: looks up `artifact_id` by
/// scanning the whole store and removes it. The workspace store is not keyed
/// by session, so this succeeds regardless of what session(s) the artifact's
/// own references happen to point at — split out from [`remove`] (which
/// additionally needs a [`ServiceCtx`] for the `analysis-update` emit) so
/// that invariant is directly unit-testable against a plain
/// `Vec<AnalysisArtifact>`.
pub(crate) fn remove_by_id(
    analyses: &mut Vec<AnalysisArtifact>,
    artifact_id: &str,
) -> Result<AnalysisArtifact, ServiceError> {
    let idx = analyses
        .iter()
        .position(|a| a.id == artifact_id)
        .ok_or_else(|| ServiceError::NotFound(format!("Analysis not found: {artifact_id}")))?;
    Ok(analyses.remove(idx))
}

/// Remove an analysis artifact by `artifact_id`, emit `analysis-update`
/// (`deleted`) carrying the removed artifact's session ids, schedule an
/// autosave flush, and journal `analysis.delete`.
pub fn remove(ctx: &ServiceCtx, artifact_id: String) -> Result<(), ServiceError> {
    let removed = {
        let mut analyses = lock_svc(&ctx.state().analyses, "analyses")?;
        remove_by_id(&mut analyses, &artifact_id)?
    };

    let session_ids = artifact_session_ids(&removed);
    let session_id = session_ids.first().cloned();

    ctx.events().emit_json(
        "analysis-update",
        serde_json::to_value(AnalysisUpdateEvent {
            artifact_id: artifact_id.clone(),
            action: "deleted".to_string(),
            session_ids,
            session_id: session_id.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "analysis.delete",
        session_id.as_deref(),
        format!("artifact {artifact_id}"),
    );

    Ok(())
}

/// List analysis artifacts. `session_id: None` returns the full workspace
/// list; `Some(sid)` filters to artifacts with at least one reference
/// attributed to `sid` (or with zero references at all — see
/// [`artifact_references_session`]). Shared by the Tauri command
/// (session_id: None, or a session-scoped call) and the two MCP bridge route
/// families (`/mcp/analyses` and `/mcp/sessions/{id}/analyses`).
pub fn list(
    ctx: &ServiceCtx,
    session_id: Option<&str>,
) -> Result<Vec<AnalysisArtifact>, ServiceError> {
    let analyses = lock_svc(&ctx.state().analyses, "analyses")?;
    Ok(match session_id {
        None => analyses.clone(),
        Some(sid) => analyses
            .iter()
            .filter(|a| artifact_references_session(a, sid))
            .cloned()
            .collect(),
    })
}

/// Get a single analysis artifact by id (workspace-unique).
pub fn get(ctx: &ServiceCtx, artifact_id: &str) -> Result<AnalysisArtifact, ServiceError> {
    let analyses = lock_svc(&ctx.state().analyses, "analyses")?;
    analyses
        .iter()
        .find(|a| a.id == artifact_id)
        .cloned()
        .ok_or_else(|| ServiceError::NotFound(format!("Analysis not found: {artifact_id}")))
}

/// Pure store-replace step for [`set_workspace`]. Deliberately does NOT call
/// `schedule_autosave` — restoring a workspace must not immediately re-persist
/// itself as a "mutation". Split out from [`set_workspace`] (which
/// additionally needs a [`ServiceCtx`] for the `analysis-update` emit) so the
/// no-autosave invariant is directly unit-testable: this function has no
/// access to `schedule_autosave` at all, so it structurally cannot call it.
pub(crate) fn replace_workspace(
    state: &AppState,
    analyses: Vec<AnalysisArtifact>,
) -> Result<(), ServiceError> {
    let mut guard = lock_svc(&state.analyses, "analyses")?;
    *guard = analyses;
    Ok(())
}

/// Wholesale replace the workspace analyses store (e.g. `.ltw` workspace
/// restore), emit `analysis-update` (`restored`), and do NOT schedule an
/// autosave flush or journal — restoring a workspace must not immediately
/// re-persist itself as a "mutation", and it is not a caller-initiated action
/// worth surfacing in the activity feed.
pub fn set_workspace(ctx: &ServiceCtx, analyses: Vec<AnalysisArtifact>) -> Result<(), ServiceError> {
    replace_workspace(ctx.state(), analyses)?;

    ctx.events().emit_json(
        "analysis-update",
        serde_json::to_value(AnalysisUpdateEvent {
            artifact_id: String::new(),
            action: "restored".to_string(),
            session_ids: vec![],
            session_id: None,
        })
        .unwrap_or_default(),
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Markdown hand-off export
// ---------------------------------------------------------------------------
//
// One analysis as a self-contained `.md` document a support engineer can send
// to someone without LogTapper or the log: the narrative plus, under each
// section, the referenced log lines themselves with a little context. A
// `SourceReference` stores only `lineNumber`/`endLine`/`sessionId`, never
// text, so the lines are read from the live session at export time — via
// `source.raw_line(n)`, under one `sessions` lock, never by direct indexing.
// If the session is gone, the reference says so instead of failing the
// document.
//
// ## Redaction — an `External` pathway
//
// The document leaves the tool, so the decision is
// `policy::should_anonymize_for(ctx, Pathway::External)`, made once per
// export and applied to every referenced session: `Ui` is redacted under
// anonymizer mode `All` and `External`, raw only under `None`; an `Agent` is
// redacted unless the mode is `None` or the user persisted `agent_raw_access`.
// There is no per-export flag — nothing in `AnalysisMarkdownOptions`, and
// nothing in an agent's request body, can loosen it — and the header's
// `anonymized` marker reflects the decision. The mechanism is
// `policy::anonymize_session_lines`, run after the `sessions` lock is dropped
// (the `export::run` pattern; the anonymizer's locks never nest under
// `sessions`). No truncation: `redact_line`'s 500-char cap is a bridge
// response concern, not an export one.
//
// ## Destination
//
// `export_markdown` authorizes `dest_path` through `policy::authorize_write_dest`
// before touching any session — `Ui` passes (the save dialog is the consent),
// an `Agent`'s destination must sit inside the open allowlist. `render_markdown`
// returns the text to the caller and is reachable from the Tauri command only:
// no bridge route returns the rendered document, which would be a bulk raw-text
// response outside the per-line cap. An agent that wants the content reads the
// file it just wrote through the ordinary open-allowlist path.

/// Default lines of context around each reference.
pub const DEFAULT_CONTEXT_LINES: usize = 2;
/// Upper bound on `context_lines`; a larger request is clamped, not rejected.
pub const MAX_CONTEXT_LINES: usize = 10;
/// Per-reference cap on emitted lines (anchors plus context), so an over-broad
/// range cannot turn one reference into a multi-megabyte document. The Ui
/// export row names this number.
pub const MAX_LINES_PER_REFERENCE: usize = 500;

fn default_context_lines() -> usize {
    DEFAULT_CONTEXT_LINES
}

/// Request for [`render_markdown`] / [`export_markdown`]. Deliberately carries
/// no redaction flag — see the section comment above.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisMarkdownOptions {
    pub artifact_id: String,
    /// Lines of context before and after each reference. Defaults to 2 and is
    /// clamped to `0..=MAX_CONTEXT_LINES`.
    #[serde(default = "default_context_lines")]
    pub context_lines: usize,
}

/// Everything [`render`] needs, resolved against `AppState` by
/// [`resolve_document`]: owned data only, so the renderer is pure and its
/// tests need neither a clock nor an `AppState`.
struct ResolvedDocument {
    title: String,
    created_at_ms: i64,
    /// Every session the artifact references, deduped in first-seen order.
    sources: Vec<SourceEntry>,
    sections: Vec<ResolvedSection>,
    context_lines: usize,
    anonymized: bool,
}

struct SourceEntry {
    session_id: String,
    /// Display name and line count while the session is open; `None` once it
    /// has been closed.
    open: Option<(String, usize)>,
}

struct ResolvedSection {
    heading: String,
    body: String,
    severity: Option<Severity>,
    references: Vec<ResolvedReference>,
}

struct ResolvedReference {
    label: String,
    /// 0-based inclusive anchor range, `end >= start`, already clamped to the
    /// source when lines were read.
    start: usize,
    end: usize,
    outcome: ReferenceOutcome,
}

enum ReferenceOutcome {
    /// Lines `first .. first + lines.len()` (0-based) of `source`, with
    /// `omitted` more past the per-reference cap.
    Lines {
        session_id: String,
        source: String,
        first: usize,
        lines: Vec<String>,
        omitted: usize,
    },
    /// The reference names a session that is no longer open.
    SessionClosed { session_id: String },
    /// `sessionId: null` — never attributed.
    Unattributed,
    /// The anchor starts at or beyond the source's last line.
    PastEof { source: String, total_lines: usize },
}

/// Read one reference's window (`start..=end` plus `context_lines` each side,
/// clamped to `[0, total_lines)`, capped at [`MAX_LINES_PER_REFERENCE`]) from
/// `src`. Returns the clamped `end` alongside the outcome so the rendered range
/// never names a line the source does not have.
fn read_window(
    session_id: &str,
    source: String,
    src: &dyn LogSource,
    start: usize,
    end: usize,
    context_lines: usize,
) -> (usize, ReferenceOutcome) {
    let total = src.total_lines();
    if start >= total {
        return (end, ReferenceOutcome::PastEof { source, total_lines: total });
    }
    let end = end.min(total - 1);
    let first = start.saturating_sub(context_lines);
    let last = end.saturating_add(context_lines).min(total - 1);
    let wanted = last - first + 1;
    let take = wanted.min(MAX_LINES_PER_REFERENCE);
    let lines = (first..first + take)
        .map(|n| src.raw_line(n).map_or_else(String::new, Cow::into_owned))
        .collect();
    (
        end,
        ReferenceOutcome::Lines {
            session_id: session_id.to_string(),
            source,
            first,
            lines,
            omitted: wanted - take,
        },
    )
}

/// Resolve `opts.artifact_id` into a [`ResolvedDocument`]: one `sessions`
/// lock for every line read, then redaction outside it.
fn resolve_document(
    ctx: &ServiceCtx,
    opts: &AnalysisMarkdownOptions,
) -> Result<ResolvedDocument, ServiceError> {
    let mut artifact = get(ctx, &opts.artifact_id)?;
    // Read-compat: an artifact persisted before per-reference attribution
    // carries its session at the artifact level; stamping it onto the
    // references is what lets them resolve at all.
    migrate_artifact(&mut artifact, None);
    let context_lines = opts.context_lines.min(MAX_CONTEXT_LINES);

    // Decided before `sessions` is taken: `anonymize_session_lines` acquires
    // the anonymizer's own locks, which must never nest under `sessions`.
    let anonymized = policy::should_anonymize_for(ctx, Pathway::External);

    let (sources, mut sections) = {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;

        let sources = artifact_session_ids(&artifact)
            .into_iter()
            .map(|session_id| {
                let open = sessions.get(&session_id).map(|s| {
                    (
                        session_display_name(s),
                        s.primary_source().map_or(0, LogSource::total_lines),
                    )
                });
                SourceEntry { session_id, open }
            })
            .collect::<Vec<_>>();

        let sections = artifact
            .sections
            .iter()
            .map(|section| ResolvedSection {
                heading: section.heading.clone(),
                body: section.body.clone(),
                severity: section.severity.clone(),
                references: section
                    .references
                    .iter()
                    .map(|r| {
                        let start = r.line_number as usize;
                        let end = (r.end_line.unwrap_or(r.line_number) as usize).max(start);
                        let (end, outcome) = match &r.session_id {
                            None => (end, ReferenceOutcome::Unattributed),
                            Some(sid) => match sessions.get(sid) {
                                None => (end, ReferenceOutcome::SessionClosed { session_id: sid.clone() }),
                                Some(session) => {
                                    let source = session_display_name(session);
                                    match session.primary_source() {
                                        Some(src) => read_window(sid, source, src, start, end, context_lines),
                                        None => (end, ReferenceOutcome::PastEof { source, total_lines: 0 }),
                                    }
                                }
                            },
                        };
                        ResolvedReference { label: r.label.clone(), start, end, outcome }
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();

        (sources, sections)
    };
    // `sessions` dropped — redaction happens here, per reference, through the
    // session's cached anonymizer so tokens match the viewer and `.lts` export.
    if anonymized {
        for section in &mut sections {
            for reference in &mut section.references {
                if let ReferenceOutcome::Lines { session_id, lines, .. } = &mut reference.outcome {
                    policy::anonymize_session_lines(ctx.state(), session_id, lines);
                }
            }
        }
    }

    Ok(ResolvedDocument {
        title: artifact.title,
        created_at_ms: artifact.created_at,
        sources,
        sections,
        context_lines,
        anonymized,
    })
}

/// `(year, month, day, hour, minute, second)` in UTC for a Unix-epoch
/// millisecond timestamp.
fn utc_parts(ms: i64) -> (i64, i64, i64, i64, i64, i64) {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = crate::core::civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    (y, m, d, sod / 3600, (sod % 3600) / 60, sod % 60)
}

/// `2026-09-18 14:02 UTC` — the header's **Created** value.
fn format_created(ms: i64) -> String {
    let (y, mo, d, h, mi, _) = utc_parts(ms);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02} UTC")
}

/// `2026-09-18T15:10:22Z` — the header's **Exported** value.
fn format_iso_utc(ms: i64) -> String {
    let (y, mo, d, h, mi, s) = utc_parts(ms);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `12431` → `12,431`.
fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// A code fence one backtick longer than the longest backtick run in `lines`
/// (CommonMark), never shorter than three — so a log line containing ``` can
/// not close the block early.
fn fence_for(lines: &[String]) -> String {
    let longest = lines
        .iter()
        .flat_map(|l| l.split(|c| c != '`').map(str::len))
        .max()
        .unwrap_or(0);
    "`".repeat(longest.max(2) + 1)
}

/// `L1204` or `L1204–L1207`, 1-based like the viewer gutter and the bookmark
/// exporter's `L${lineNumber + 1}`.
fn format_range(start: usize, end: usize) -> String {
    if end > start {
        format!("L{}–L{}", start + 1, end + 1)
    } else {
        format!("L{}", start + 1)
    }
}

fn render_reference(out: &mut String, r: &ResolvedReference, context_lines: usize) {
    let range = format_range(r.start, r.end);
    match &r.outcome {
        ReferenceOutcome::Lines { source, first, lines, omitted, .. } => {
            let context = if context_lines > 0 { format!(" (±{context_lines} lines)") } else { String::new() };
            out.push_str(&format!("**{}** — {source} {range}{context}\n", r.label));
            let fence = fence_for(lines);
            out.push_str(&fence);
            out.push_str("log\n");
            // Right-aligned to the last emitted 1-based number so the gutter
            // lines up across the block.
            let width = (first + lines.len()).to_string().len();
            for (i, text) in lines.iter().enumerate() {
                let n = first + i;
                let marker = if n >= r.start && n <= r.end { "> " } else { "  " };
                out.push_str(&format!("{marker}{:>width$}  {text}\n", n + 1));
            }
            out.push_str(&fence);
            out.push('\n');
            if *omitted > 0 {
                out.push_str(&format!("… {} more lines not shown\n", group_thousands(*omitted)));
            }
        }
        ReferenceOutcome::SessionClosed { session_id } => out.push_str(&format!(
            "**{}** — {session_id} {range} — *source no longer open; lines unavailable*\n",
            r.label
        )),
        ReferenceOutcome::Unattributed => out.push_str(&format!(
            "**{}** — {range} — *reference has no session; lines unavailable*\n",
            r.label
        )),
        ReferenceOutcome::PastEof { source, total_lines } => out.push_str(&format!(
            "**{}** — {source} {range} — *line past end of source ({} lines); lines unavailable*\n",
            r.label,
            group_thousands(*total_lines)
        )),
    }
}

/// Pure renderer: `doc` plus the export time in → the whole document out.
/// Header layout follows `src-shared/bookmarks/exportMarkdown.ts` (title, bold
/// key/value lines, a rule) so the two hand-off documents read alike.
fn render(doc: &ResolvedDocument, now_ms: i64) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", doc.title));
    out.push_str(&format!("**Created:** {}\n", format_created(doc.created_at_ms)));

    let sources = if doc.sources.is_empty() {
        "none".to_string()
    } else {
        doc.sources
            .iter()
            .map(|s| match &s.open {
                Some((name, total)) => format!("{name} ({} lines)", group_thousands(*total)),
                None => format!("{} (closed)", s.session_id),
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    out.push_str(&format!("**Sources:** {sources}\n"));

    out.push_str(&format!("**Sections:** {}", doc.sections.len()));
    for severity in [Severity::Critical, Severity::Error, Severity::Warning, Severity::Info] {
        let n = doc.sections.iter().filter(|s| s.severity.as_ref() == Some(&severity)).count();
        if n > 0 {
            out.push_str(&format!(" · {n} {severity:?}"));
        }
    }
    out.push('\n');

    out.push_str(&format!(
        "**Exported:** {}{}\n",
        format_iso_utc(now_ms),
        if doc.anonymized { " · anonymized" } else { "" }
    ));
    out.push_str("\n---\n\n");

    for section in &doc.sections {
        match &section.severity {
            Some(severity) => out.push_str(&format!("## [{severity:?}] {}\n\n", section.heading)),
            None => out.push_str(&format!("## {}\n\n", section.heading)),
        }
        // The author's markdown, verbatim: this is a serializer, not a sanitizer.
        if !section.body.is_empty() {
            out.push_str(&section.body);
            if !section.body.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
        }
        if !section.references.is_empty() {
            out.push_str("### Evidence\n\n");
            for reference in &section.references {
                render_reference(&mut out, reference, doc.context_lines);
                out.push('\n');
            }
        }
        out.push_str("---\n\n");
    }
    out
}

/// Render one analysis as a Markdown hand-off document and return it. Feeds
/// the Ui's **Copy**; deliberately has no bridge route (see the section
/// comment above). Redaction is [`policy::should_anonymize_for`]`(External)`.
pub fn render_markdown(ctx: &ServiceCtx, opts: AnalysisMarkdownOptions) -> Result<String, ServiceError> {
    let doc = resolve_document(ctx, &opts)?;
    Ok(render(&doc, crate::workspace::now_ms()))
}

/// Render one analysis and write it to `dest_path`. The destination is
/// authorized via [`policy::authorize_write_dest`] before any session is
/// read; the write runs off the async runtime like `export::run`'s. Journals
/// `analysis.export` on success.
pub async fn export_markdown(
    ctx: ServiceCtx,
    opts: AnalysisMarkdownOptions,
    dest_path: String,
) -> Result<(), ServiceError> {
    let dest = policy::authorize_write_dest(&ctx, &dest_path)?;
    let artifact_id = opts.artifact_id.clone();
    let markdown = render_markdown(&ctx, opts)?;

    let dest_for_write = dest.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&dest_for_write, markdown.as_bytes()))
        .await
        .map_err(|e| ServiceError::Internal(format!("Export task panicked: {e}")))?
        .map_err(|e| ServiceError::Internal(format!("Failed to write {}: {e}", dest.display())))?;

    ctx.journal(
        "analysis.export",
        None,
        format!("artifact {artifact_id} -> {}", dest.display()),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::analysis::{HighlightType, SourceReference};
    use crate::services::testing::test_ctx;
    use crate::workspace::autosave::has_pending_flush;

    fn artifact_with_ref(id: &str, session_id: &str) -> AnalysisArtifact {
        AnalysisArtifact {
            id: id.to_string(),
            title: id.to_string(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: vec![SourceReference {
                    line_number: 1,
                    end_line: None,
                    label: "ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: Some(session_id.to_string()),
                }],
                severity: None,
            }],
            legacy_session_id: None,
        }
    }

    fn artifact_with_unattributed_ref(id: &str) -> AnalysisArtifact {
        AnalysisArtifact {
            id: id.to_string(),
            title: id.to_string(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: vec![SourceReference {
                    line_number: 1,
                    end_line: None,
                    label: "ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: None,
                }],
                severity: None,
            }],
            legacy_session_id: None,
        }
    }

    // ── publish ──────────────────────────────────────────────────────────

    #[test]
    fn publish_emits_one_event_journals_and_schedules_autosave() {
        let (ctx, sink, _tmp) = test_ctx().agent("claude-code").with_session("s1", 5).build_recording();

        let art = publish(&ctx, Some("s1".to_string()), "Title".to_string(), vec![])
            .expect("publish must succeed for an existing session");

        let payload = sink.only_event("analysis-update");
        assert_eq!(payload["action"], "published");
        assert_eq!(payload["artifactId"], art.id);

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "analysis.publish");
        assert_eq!(activity[0].caller, crate::services::Caller::agent("claude-code"));

        assert!(has_pending_flush(ctx.state()), "publish must schedule an autosave flush");
    }

    #[test]
    fn publish_rejects_unknown_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = publish(&ctx, Some("missing".to_string()), "T".to_string(), vec![])
            .expect_err("must fail for a session that does not exist");
        assert_eq!(err.message(), "Session not found: missing");
    }

    #[test]
    fn publish_workspace_level_skips_session_verification() {
        let (ctx, _tmp) = test_ctx().build();
        let art = publish(&ctx, None, "Workspace-level".to_string(), vec![])
            .expect("workspace-level publish needs no session");
        assert_eq!(art.title, "Workspace-level");
    }

    // ── apply_update (pure) ──────────────────────────────────────────────

    #[test]
    fn scoped_update_with_unattributed_references_keeps_them_attributed_to_the_path_session() {
        let mut art = artifact_with_unattributed_ref("art-scoped");

        apply_update(
            &mut art,
            None,
            Some(vec![AnalysisSection {
                heading: "New".to_string(),
                body: "New body".to_string(),
                references: vec![SourceReference {
                    line_number: 2,
                    end_line: None,
                    label: "new-ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: None,
                }],
                severity: None,
            }]),
            Some("sess-path"),
        );

        assert_eq!(
            art.sections[0].references[0].session_id.as_deref(),
            Some("sess-path"),
            "scoped update must stamp unattributed references with the path session"
        );
    }

    #[test]
    fn workspace_update_with_no_fallback_leaves_unattributed_references_alone() {
        let mut art = artifact_with_unattributed_ref("art-workspace");

        apply_update(
            &mut art,
            None,
            Some(vec![AnalysisSection {
                heading: "New".to_string(),
                body: "New body".to_string(),
                references: vec![SourceReference {
                    line_number: 2,
                    end_line: None,
                    label: "new-ref".to_string(),
                    highlight_type: HighlightType::default(),
                    session_id: None,
                }],
                severity: None,
            }]),
            None,
        );

        assert_eq!(
            art.sections[0].references[0].session_id, None,
            "workspace route (no fallback) must leave an unattributed reference unattributed"
        );
    }

    #[test]
    fn update_emits_updated_event_and_journals() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        let art = publish(&ctx, None, "T".to_string(), vec![]).unwrap();
        sink.clear();

        let updated = update(&ctx, art.id, Some("New title".to_string()), None, None)
            .expect("update must find the artifact just published");
        assert_eq!(updated.title, "New title");

        let payload = sink.only_event("analysis-update");
        assert_eq!(payload["action"], "updated");

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.last().unwrap().action, "analysis.update");
    }

    #[test]
    fn update_errors_when_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = update(&ctx, "no-such-id".to_string(), None, None, None)
            .expect_err("must fail for an unknown artifact");
        assert_eq!(err.message(), "Analysis not found: no-such-id");
    }

    // ── remove_by_id (pure) ──────────────────────────────────────────────

    #[test]
    fn delete_by_artifact_id_finds_artifact_regardless_of_session() {
        let mut analyses = vec![
            artifact_with_ref("art-a", "sess-a"),
            artifact_with_ref("art-b", "sess-b"),
            artifact_with_ref("art-c", "sess-c"),
        ];

        let removed = remove_by_id(&mut analyses, "art-b").expect("must find art-b");

        assert_eq!(removed.id, "art-b");
        assert_eq!(analyses.len(), 2);
        assert!(analyses.iter().any(|a| a.id == "art-a"));
        assert!(analyses.iter().any(|a| a.id == "art-c"));
        assert!(!analyses.iter().any(|a| a.id == "art-b"));
    }

    #[test]
    fn delete_by_artifact_id_errors_when_not_found() {
        let mut analyses = vec![artifact_with_ref("art-a", "sess-a")];
        let err = remove_by_id(&mut analyses, "does-not-exist")
            .expect_err("must error for an unknown artifact_id");
        assert_eq!(err.message(), "Analysis not found: does-not-exist");
    }

    #[test]
    fn remove_emits_deleted_event_and_journals() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        let art = publish(&ctx, None, "T".to_string(), vec![]).unwrap();
        sink.clear();

        remove(&ctx, art.id).expect("must remove");
        let payload = sink.only_event("analysis-update");
        assert_eq!(payload["action"], "deleted");
        assert!(list(&ctx, None).unwrap().is_empty());

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.last().unwrap().action, "analysis.delete");
    }

    // ── list / get ───────────────────────────────────────────────────────

    #[test]
    fn list_filtered_by_session_returns_only_referencing_artifacts() {
        let (ctx, _tmp) = test_ctx().build();
        {
            let mut analyses = ctx.state().analyses.lock().unwrap();
            analyses.push(artifact_with_ref("art-a", "sess-a"));
            analyses.push(artifact_with_ref("art-b", "sess-b"));
        }

        let result = list(&ctx, Some("sess-a")).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "art-a");
    }

    #[test]
    fn list_unfiltered_returns_all() {
        let (ctx, _tmp) = test_ctx().build();
        {
            let mut analyses = ctx.state().analyses.lock().unwrap();
            analyses.push(artifact_with_ref("art-a", "sess-a"));
            analyses.push(artifact_with_ref("art-b", "sess-b"));
        }

        let result = list(&ctx, None).unwrap();
        assert_eq!(result.len(), 2, "session_id: None must return the full workspace list");
    }

    #[test]
    fn get_finds_by_artifact_id() {
        let (ctx, _tmp) = test_ctx().build();
        let art = publish(&ctx, None, "Findable".to_string(), vec![]).unwrap();
        let found = get(&ctx, &art.id).unwrap();
        assert_eq!(found.title, "Findable");
    }

    #[test]
    fn get_errors_when_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = get(&ctx, "missing").expect_err("must fail for unknown artifact");
        assert_eq!(err.message(), "Analysis not found: missing");
    }

    // ── set_workspace / replace_workspace ───────────────────────────────

    #[test]
    fn set_workspace_does_not_schedule_autosave_but_does_emit() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();

        set_workspace(&ctx, vec![artifact_with_ref("art-a", "sess-a")])
            .expect("restore must succeed");

        assert!(
            !has_pending_flush(ctx.state()),
            "restoring the workspace analyses store must not schedule an autosave flush"
        );
        let payload = sink.only_event("analysis-update");
        assert_eq!(payload["action"], "restored");
        assert_eq!(list(&ctx, None).unwrap().len(), 1);

        assert!(
            ctx.state().activity.list(None, None).is_empty(),
            "restoring a workspace must not journal an activity entry"
        );
    }

    // ── Markdown hand-off export ─────────────────────────────────────────

    mod markdown {
        use super::*;
        use crate::anonymizer::config::AnonymizerMode;
        use crate::services::testing::fixture_session_from;
        use crate::services::Caller;

        /// 2026-09-18T15:10:22Z, the plan's worked example.
        const NOW_MS: i64 = 1_789_744_222_000;

        fn lines_outcome(first: usize, lines: &[&str]) -> ReferenceOutcome {
            ReferenceOutcome::Lines {
                session_id: "s1".into(),
                source: "app.log".into(),
                first,
                lines: lines.iter().map(|l| (*l).to_string()).collect(),
                omitted: 0,
            }
        }

        fn reference(label: &str, start: usize, end: usize, outcome: ReferenceOutcome) -> ResolvedReference {
            ResolvedReference { label: label.into(), start, end, outcome }
        }

        fn section(heading: &str, severity: Option<Severity>, references: Vec<ResolvedReference>) -> ResolvedSection {
            ResolvedSection { heading: heading.into(), body: "Body text.".into(), severity, references }
        }

        fn doc(sections: Vec<ResolvedSection>) -> ResolvedDocument {
            ResolvedDocument {
                title: "Crash loop".into(),
                created_at_ms: 1_789_740_120_000,
                sources: vec![SourceEntry { session_id: "s1".into(), open: Some(("app.log".into(), 12_431)) }],
                sections,
                context_lines: 2,
                anonymized: false,
            }
        }

        // ── render (pure) ────────────────────────────────────────────────

        #[test]
        fn header_names_created_sources_sections_and_export_time() {
            let out = render(
                &doc(vec![
                    section("A", Some(Severity::Critical), vec![]),
                    section("B", Some(Severity::Warning), vec![]),
                    section("C", Some(Severity::Warning), vec![]),
                    section("D", None, vec![]),
                ]),
                NOW_MS,
            );
            assert!(out.starts_with("# Crash loop\n\n**Created:** 2026-09-18 14:02 UTC\n"), "{out}");
            assert!(out.contains("**Sources:** app.log (12,431 lines)\n"), "{out}");
            assert!(out.contains("**Sections:** 4 · 1 Critical · 2 Warning\n"), "{out}");
            assert!(out.contains("**Exported:** 2026-09-18T15:10:22Z\n\n---\n"), "{out}");
            assert!(!out.contains("anonymized"));
        }

        #[test]
        fn anonymized_suffix_follows_the_decision() {
            let mut d = doc(vec![]);
            d.anonymized = true;
            let out = render(&d, NOW_MS);
            assert!(out.contains("**Exported:** 2026-09-18T15:10:22Z · anonymized\n"), "{out}");
        }

        #[test]
        fn closed_source_is_named_by_id_in_the_header() {
            let mut d = doc(vec![]);
            d.sources.push(SourceEntry { session_id: "gone".into(), open: None });
            let out = render(&d, NOW_MS);
            assert!(out.contains("**Sources:** app.log (12,431 lines), gone (closed)\n"), "{out}");
        }

        #[test]
        fn severity_prefix_is_present_only_when_set() {
            let out = render(
                &doc(vec![section("Root cause", Some(Severity::Error), vec![]), section("Next steps", None, vec![])]),
                NOW_MS,
            );
            assert!(out.contains("## [Error] Root cause\n\nBody text.\n\n---\n"), "{out}");
            assert!(out.contains("## Next steps\n\nBody text.\n\n---\n"), "{out}");
        }

        #[test]
        fn body_is_emitted_verbatim() {
            let mut s = section("H", None, vec![]);
            s.body = "<script>alert(1)</script>\n\n- item with `code`\n".into();
            let out = render(&doc(vec![s]), NOW_MS);
            assert!(out.contains("## H\n\n<script>alert(1)</script>\n\n- item with `code`\n\n---\n"), "{out}");
        }

        #[test]
        fn a_section_without_references_has_no_evidence_block() {
            let out = render(&doc(vec![section("Prose", None, vec![])]), NOW_MS);
            assert!(!out.contains("### Evidence"), "{out}");
        }

        #[test]
        fn lines_are_one_based_with_anchor_and_context_markers_right_aligned() {
            // Stored 0-based range 8..=9 (document L9–L10), context 2 → lines 6..=11.
            let r = reference(
                "Binder timeout",
                8,
                9,
                lines_outcome(6, &["l7", "l8", "l9", "l10", "l11", "l12"]),
            );
            let out = render(&doc(vec![section("S", None, vec![r])]), NOW_MS);
            // Built line by line: a `\`-continued literal strips the leading
            // whitespace this very test is about.
            let expected = [
                "### Evidence",
                "",
                "**Binder timeout** — app.log L9–L10 (±2 lines)",
                "```log",
                "   7  l7",
                "   8  l8",
                ">  9  l9",
                "> 10  l10",
                "  11  l11",
                "  12  l12",
                "```",
                "",
                "---",
                "",
            ]
            .join("\n");
            assert!(out.contains(&expected), "{out}");
        }

        #[test]
        fn single_line_reference_names_one_line_and_omits_the_context_note_at_zero() {
            let r = reference("lmkd kill", 4, 4, lines_outcome(4, &["kill"]));
            let mut d = doc(vec![section("S", None, vec![r])]);
            d.context_lines = 0;
            let out = render(&d, NOW_MS);
            assert!(out.contains("**lmkd kill** — app.log L5\n```log\n> 5  kill\n```\n"), "{out}");
        }

        #[test]
        fn fence_is_one_backtick_longer_than_the_longest_run_in_the_content() {
            let r = reference("f", 0, 0, lines_outcome(0, &["has ``` inside", "and ````` five"]));
            let out = render(&doc(vec![section("S", None, vec![r])]), NOW_MS);
            assert!(out.contains("``````log\n> 1  has ``` inside\n  2  and ````` five\n``````\n"), "{out}");
        }

        #[test]
        fn fence_never_drops_below_three_backticks() {
            let r = reference("f", 0, 0, lines_outcome(0, &["plain"]));
            let out = render(&doc(vec![section("S", None, vec![r])]), NOW_MS);
            assert!(out.contains("```log\n> 1  plain\n```\n"), "{out}");
        }

        #[test]
        fn cap_trailer_reports_the_omitted_count() {
            let mut r = reference("wide", 0, 999, lines_outcome(0, &["a", "b"]));
            if let ReferenceOutcome::Lines { omitted, .. } = &mut r.outcome {
                *omitted = 1_498;
            }
            let out = render(&doc(vec![section("S", None, vec![r])]), NOW_MS);
            assert!(out.contains("```\n… 1,498 more lines not shown\n"), "{out}");
        }

        #[test]
        fn overlapping_references_render_independently() {
            let a = reference("first", 2, 3, lines_outcome(0, &["l1", "l2", "l3", "l4", "l5", "l6"]));
            let b = reference("second", 3, 4, lines_outcome(1, &["l2", "l3", "l4", "l5", "l6", "l7"]));
            let out = render(&doc(vec![section("S", None, vec![a, b])]), NOW_MS);
            assert_eq!(out.matches("```log\n").count(), 2, "{out}");
            assert!(out.contains("**first** — app.log L3–L4"), "{out}");
            assert!(out.contains("**second** — app.log L4–L5"), "{out}");
            // Line 4 (0-based 3) is an anchor in both blocks; line 5 only in the second.
            assert!(out.contains("> 4  l4\n  5  l5\n"), "{out}");
            assert!(out.contains("> 4  l4\n> 5  l5\n"), "{out}");
        }

        #[test]
        fn unresolvable_references_render_one_line_italic_notes() {
            let closed = reference("Session closed", 87, 87, ReferenceOutcome::SessionClosed { session_id: "old".into() });
            let null = reference("Unattributed", 39, 39, ReferenceOutcome::Unattributed);
            let eof = reference(
                "Past EOF",
                20_000,
                20_000,
                ReferenceOutcome::PastEof { source: "app.log".into(), total_lines: 12_431 },
            );
            let out = render(&doc(vec![section("S", None, vec![closed, null, eof])]), NOW_MS);
            assert!(out.contains("**Session closed** — old L88 — *source no longer open; lines unavailable*\n"), "{out}");
            assert!(out.contains("**Unattributed** — L40 — *reference has no session; lines unavailable*\n"), "{out}");
            assert!(
                out.contains("**Past EOF** — app.log L20001 — *line past end of source (12,431 lines); lines unavailable*\n"),
                "{out}"
            );
            assert!(!out.contains("```"), "no fence for a reference with no lines: {out}");
        }

        // ── read_window (clamping) ───────────────────────────────────────

        fn numbered(n: usize) -> crate::core::session::AnalysisSession {
            fixture_session_from("s1", (0..n).map(|i| format!("line {i}")).collect())
        }

        fn window(session: &crate::core::session::AnalysisSession, start: usize, end: usize, ctx: usize) -> (usize, usize, Vec<String>, usize) {
            let src = session.primary_source().unwrap();
            match read_window("s1", "app.log".into(), src, start, end, ctx) {
                (end, ReferenceOutcome::Lines { first, lines, omitted, .. }) => (end, first, lines, omitted),
                _ => panic!("expected lines"),
            }
        }

        #[test]
        fn context_is_clamped_at_the_start_of_the_file() {
            let s = numbered(10);
            let (end, first, lines, omitted) = window(&s, 1, 1, 3);
            assert_eq!((end, first, omitted), (1, 0, 0));
            assert_eq!(lines, ["line 0", "line 1", "line 2", "line 3", "line 4"]);
        }

        #[test]
        fn range_and_context_are_clamped_at_the_end_of_the_file() {
            let s = numbered(10);
            let (end, first, lines, omitted) = window(&s, 8, 50, 3);
            assert_eq!(end, 9, "the anchor range is clamped to the last line");
            assert_eq!((first, omitted), (5, 0));
            assert_eq!(lines, ["line 5", "line 6", "line 7", "line 8", "line 9"]);
        }

        #[test]
        fn context_is_applied_once_around_the_whole_range() {
            let s = numbered(100);
            let (_, first, lines, _) = window(&s, 10, 20, 2);
            assert_eq!(first, 8);
            assert_eq!(lines.len(), 15, "8..=22, not 2 lines of context per anchor line");
        }

        #[test]
        fn a_start_past_eof_is_reported_not_read() {
            let s = numbered(10);
            let src = s.primary_source().unwrap();
            match read_window("s1", "app.log".into(), src, 10, 12, 2) {
                (_, ReferenceOutcome::PastEof { total_lines, .. }) => assert_eq!(total_lines, 10),
                _ => panic!("expected PastEof"),
            }
        }

        #[test]
        fn window_is_capped_per_reference_with_the_remainder_counted() {
            let s = numbered(2_000);
            let (_, first, lines, omitted) = window(&s, 100, 1_500, 2);
            assert_eq!(first, 98);
            assert_eq!(lines.len(), MAX_LINES_PER_REFERENCE);
            assert_eq!(omitted, 1_405 - MAX_LINES_PER_REFERENCE);
        }

        // ── resolve_document / render_markdown (against AppState) ────────

        fn artifact_with(references: Vec<SourceReference>, legacy: Option<&str>) -> AnalysisArtifact {
            AnalysisArtifact {
                id: "art-md".to_string(),
                title: "Handoff".to_string(),
                created_at: 0,
                sections: vec![AnalysisSection {
                    heading: "H".to_string(),
                    body: "B".to_string(),
                    references,
                    severity: Some(Severity::Warning),
                }],
                legacy_session_id: legacy.map(str::to_string),
            }
        }

        fn source_ref(line: u32, end: Option<u32>, session_id: Option<&str>) -> SourceReference {
            SourceReference {
                line_number: line,
                end_line: end,
                label: format!("ref-{line}"),
                highlight_type: HighlightType::default(),
                session_id: session_id.map(str::to_string),
            }
        }

        fn opts(context_lines: usize) -> AnalysisMarkdownOptions {
            AnalysisMarkdownOptions { artifact_id: "art-md".into(), context_lines }
        }

        #[test]
        fn render_markdown_resolves_lines_from_the_live_session() {
            let (ctx, _tmp) = test_ctx().anonymizer_mode(AnonymizerMode::None).with_session("s1", 20).build();
            ctx.state().analyses.lock().unwrap().push(artifact_with(vec![source_ref(5, Some(6), Some("s1"))], None));

            let out = render_markdown(&ctx, opts(1)).unwrap();
            assert!(out.contains("**Sources:** fixture (20 lines)\n"), "{out}");
            assert!(out.contains("## [Warning] H\n\nB\n\n### Evidence\n\n**ref-5** — fixture L6–L7 (±1 lines)\n```log\n  5  line 4\n> 6  line 5\n> 7  line 6\n  8  line 7\n```\n"), "{out}");
        }

        #[test]
        fn render_markdown_reports_closed_null_and_past_eof_references_without_failing() {
            let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
            ctx.state().analyses.lock().unwrap().push(artifact_with(
                vec![source_ref(1, None, Some("closed")), source_ref(2, None, None), source_ref(9, None, Some("s1"))],
                None,
            ));

            let out = render_markdown(&ctx, opts(2)).unwrap();
            assert!(out.contains("**Sources:** closed (closed), fixture (5 lines)\n"), "{out}");
            assert!(out.contains("**ref-1** — closed L2 — *source no longer open; lines unavailable*"), "{out}");
            assert!(out.contains("**ref-2** — L3 — *reference has no session; lines unavailable*"), "{out}");
            assert!(out.contains("**ref-9** — fixture L10 — *line past end of source (5 lines); lines unavailable*"), "{out}");
        }

        #[test]
        fn render_markdown_uses_the_legacy_artifact_session_id_as_the_fallback() {
            let (ctx, _tmp) = test_ctx().anonymizer_mode(AnonymizerMode::None).with_session("s1", 5).build();
            ctx.state().analyses.lock().unwrap().push(artifact_with(vec![source_ref(0, None, None)], Some("s1")));

            let out = render_markdown(&ctx, opts(0)).unwrap();
            assert!(out.contains("**ref-0** — fixture L1\n```log\n> 1  line 0\n```\n"), "{out}");
        }

        #[test]
        fn render_markdown_clamps_context_lines_to_the_maximum() {
            let (ctx, _tmp) = test_ctx().anonymizer_mode(AnonymizerMode::None).with_session("s1", 100).build();
            ctx.state().analyses.lock().unwrap().push(artifact_with(vec![source_ref(50, None, Some("s1"))], None));

            let out = render_markdown(&ctx, opts(99)).unwrap();
            assert!(out.contains("(±10 lines)"), "{out}");
            assert!(out.contains("  41  line 40\n"), "{out}");
            assert!(!out.contains("line 39"), "{out}");
        }

        #[test]
        fn render_markdown_unknown_artifact_is_not_found() {
            let (ctx, _tmp) = test_ctx().build();
            let err = render_markdown(&ctx, opts(2)).unwrap_err();
            assert_eq!(err.code(), "NOT_FOUND");
        }

        #[test]
        fn context_lines_defaults_to_two_when_absent_from_the_payload() {
            let parsed: AnalysisMarkdownOptions = serde_json::from_str(r#"{"artifactId":"a"}"#).unwrap();
            assert_eq!(parsed.context_lines, DEFAULT_CONTEXT_LINES);
        }

        // ── the redaction decision, per caller (External pathway) ────────

        fn pii_ctx(caller_agent: bool, mode: AnonymizerMode, raw_access: bool) -> (ServiceCtx, tempfile::TempDir) {
            let mut b = test_ctx().anonymizer_mode(mode).agent_raw_access(raw_access).with_pii_session("s1", 3);
            if caller_agent {
                b = b.caller(Caller::Agent { client: "mcp".into() });
            }
            let (ctx, tmp) = b.build();
            ctx.state().analyses.lock().unwrap().push(artifact_with(vec![source_ref(1, None, Some("s1"))], None));
            (ctx, tmp)
        }

        #[test]
        fn ui_is_redacted_under_all_and_external_and_raw_under_none() {
            for (mode, expect_raw) in [
                (AnonymizerMode::All, false),
                (AnonymizerMode::External, false),
                (AnonymizerMode::None, true),
            ] {
                let (ctx, _tmp) = pii_ctx(false, mode, false);
                let out = render_markdown(&ctx, opts(0)).unwrap();
                assert_eq!(out.contains("user1@example.com"), expect_raw, "{mode:?}: {out}");
                assert_eq!(out.contains("<EMAIL-"), !expect_raw, "{mode:?}: {out}");
                assert_eq!(out.contains("· anonymized"), !expect_raw, "{mode:?}: header marker");
            }
        }

        #[test]
        fn agent_is_raw_only_under_none_or_raw_access() {
            for (mode, raw_access, expect_raw) in [
                (AnonymizerMode::All, false, false),
                (AnonymizerMode::External, false, false),
                (AnonymizerMode::None, false, true),
                (AnonymizerMode::External, true, true),
            ] {
                let (ctx, _tmp) = pii_ctx(true, mode, raw_access);
                let out = render_markdown(&ctx, opts(0)).unwrap();
                assert_eq!(out.contains("user1@example.com"), expect_raw, "{mode:?}/raw_access={raw_access}: {out}");
                assert_eq!(out.contains("· anonymized"), !expect_raw, "{mode:?}/raw_access={raw_access}: header marker");
            }
        }

        // ── export_markdown (destination gate + write + journal) ─────────

        #[tokio::test]
        async fn export_agent_outside_the_allowlist_is_forbidden_and_writes_nothing() {
            let (ctx, tmp) = pii_ctx(true, AnonymizerMode::External, false);
            let dest = tmp.path().join("nope.md");
            let err = export_markdown(ctx, opts(2), dest.to_string_lossy().to_string()).await.unwrap_err();
            assert_eq!(err.code(), "NOT_ALLOWED");
            assert!(!dest.exists());
        }

        #[tokio::test]
        async fn export_agent_inside_the_allowlist_writes_a_redacted_document() {
            let (ctx, tmp) = pii_ctx(true, AnonymizerMode::External, false);
            let out_dir = tmp.path().join("allowed");
            std::fs::create_dir_all(&out_dir).unwrap();
            ctx.state()
                .mcp_open_allowlist
                .lock()
                .unwrap()
                .allowed_dirs
                .push(out_dir.to_string_lossy().to_string());
            let dest = out_dir.join("handoff.md");

            export_markdown(ctx.clone(), opts(2), dest.to_string_lossy().to_string()).await.unwrap();
            let text = std::fs::read_to_string(&dest).unwrap();
            assert!(text.starts_with("# Handoff\n"), "{text}");
            assert!(!text.contains("@example.com"), "{text}");
            assert!(text.contains("· anonymized"), "{text}");

            let entries = ctx.state().activity.list(None, None);
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].action, "analysis.export");
            assert!(entries[0].summary.contains("art-md"), "{}", entries[0].summary);
        }

        #[tokio::test]
        async fn export_ui_writes_wherever_the_dialog_chose() {
            let (ctx, tmp) = pii_ctx(false, AnonymizerMode::None, false);
            let dest = tmp.path().join("ui.md");
            export_markdown(ctx, opts(2), dest.to_string_lossy().to_string()).await.unwrap();
            let text = std::fs::read_to_string(&dest).unwrap();
            assert!(text.contains("user1@example.com"), "None: raw, exports included: {text}");
        }

        #[tokio::test]
        async fn export_unknown_artifact_is_not_found_and_writes_nothing() {
            let (ctx, tmp) = test_ctx().build();
            let dest = tmp.path().join("missing.md");
            let err = export_markdown(ctx, opts(2), dest.to_string_lossy().to_string()).await.unwrap_err();
            assert_eq!(err.code(), "NOT_FOUND");
            assert!(!dest.exists());
        }
    }
}
