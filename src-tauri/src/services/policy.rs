//! Caller-identity gates.
//!
//! Everything a `Ui` caller is allowed to do implicitly (the user picked the
//! file in a native dialog; the user is looking at their own unredacted logs)
//! and an `Agent` caller is not. The decision lives here, once, so no service
//! can accidentally answer it differently.
//!
//! Three gates:
//!
//! - [`authorize_open`] — may this caller open this path?
//! - [`should_anonymize_for`] — must raw text on this [`Pathway`] be redacted
//!   for this caller? ([`should_anonymize`] is its `Internal` shorthand.)
//! - [`redact_line`] / [`redact_lines`] — the choke points every raw-text
//!   response goes through.
//!
//! The anonymization helpers below (`anonymize_session_text`,
//! `anonymize_scan_line`, `truncate_str`) were moved here from `mcp_bridge.rs`
//! with their tests, and the bridge calls them from here. Their
//! anonymize-before-truncate contract is unchanged and still pinned by those
//! tests — it is the difference between an agent seeing a redacted log and an
//! agent seeing a user's email address.
//!
//! **Anonymization is a single global decision, not a per-session one.** Two
//! persisted, `Ui`-only settings feed it: the anonymizer *mode*
//! (`AnonymizerConfig::mode` — `All` / `External` / `None`, written only by
//! `services::settings::set_anonymizer_config`) and the agent raw-access
//! opt-out (`AppState::agent_raw_access`, written only by
//! `services::settings::set_agent_raw_access`). Nothing a session carries —
//! above all its pipeline chain — participates. (The per-session
//! `mcp_anonymize` map this replaced was mirrored from each session's chain by
//! the frontend, which meant the default chain silently turned agent
//! anonymization *off*.)

use std::path::PathBuf;

use crate::anonymizer::config::AnonymizerMode;
use crate::anonymizer::LogAnonymizer;
use crate::commands::AppState;

use super::error::{ServiceError, INVALID_PATH, NOT_ALLOWED};
use super::{Caller, ServiceCtx};

// ---------------------------------------------------------------------------
// Open-file gate
// ---------------------------------------------------------------------------

/// Decide whether `path` may be opened by this caller, returning the canonical
/// path to open on success.
///
/// - `Ui`: passes through. The native file dialog IS the consent step — the
///   user picked this file. Only path canonicalization is applied, so the
///   stored session id is stable regardless of the spelling.
/// - `Agent`: runs the existing [`crate::commands::bridge_access::validate_open_path`]
///   gate against the configured allowlist plus the set of already-open
///   file-backed sessions (reopening what is already open is always permitted).
///
/// The `NotAllowed` refusal deliberately does not distinguish "outside the
/// allowlist" from "does not exist" — an agent must not be able to probe the
/// filesystem through this error. Do not add a branch that tells them apart.
pub fn authorize_open(ctx: &ServiceCtx, path: &str) -> Result<PathBuf, ServiceError> {
    use crate::commands::bridge_access::{canonical_compare_form, validate_open_path, OpenAccessError};

    if matches!(ctx.caller(), Caller::Ui) {
        let p = std::path::Path::new(path);
        return Ok(crate::simplified_path(p));
    }

    let state = ctx.state();

    // Allowlist: lock, clone both fields, drop.
    let (allowed, allow_all): (Vec<String>, bool) = {
        let cfg = state
            .mcp_open_allowlist
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (cfg.allowed_dirs.clone(), cfg.allow_all)
    };

    // Canonical paths of already-open file-backed sessions (auto-permit reopen).
    let open_paths: Vec<String> = {
        let sessions = super::lock_svc(&state.sessions, "sessions")?;
        sessions
            .values()
            .filter_map(|s| s.file_path.as_deref())
            .filter_map(|p| canonical_compare_form(std::path::Path::new(p)))
            .collect()
    };

    match validate_open_path(&allowed, &open_paths, path, allow_all) {
        Ok(canonical) => Ok(canonical),
        Err(OpenAccessError::NotAllowed) => Err(ServiceError::Forbidden {
            code: NOT_ALLOWED,
            message: "path is not allowed".to_string(),
        }),
        Err(OpenAccessError::InvalidPath(msg)) => Err(ServiceError::InvalidArg {
            code: INVALID_PATH,
            message: msg,
        }),
    }
}

// ---------------------------------------------------------------------------
// Write-destination gate
// ---------------------------------------------------------------------------

/// Decide whether `raw` may be written to by this caller, returning the
/// canonical path to write on success.
///
/// - `Ui`: passes through untouched — the native save dialog is the consent
///   step, and rewriting the string the dialog handed back would change what
///   the desktop writes today.
/// - `Agent`: held to the same containment rule as [`authorize_open`], with
///   one necessary difference: the destination usually does not exist yet, so
///   the whole path cannot be canonicalized the way an *open* target can.
///   Only the destination's **parent directory** (which must already exist)
///   is validated — via [`crate::commands::bridge_access::validate_open_path`],
///   the exact same raw-form-hygiene-then-canonicalize-then-containment gate
///   `authorize_open` uses, called on the parent instead of the whole path
///   (with the "already open session" auto-permit disabled via an empty
///   `open_session_canonical_paths` — that has no meaning for a write). The
///   file name itself is required to be a single plain segment, free of an
///   NTFS alternate-data-stream suffix — `validate_open_path` never sees the
///   file name, so that one hygiene check is not delegated.
///
/// This consolidates three call-for-call-identical copies that used to live
/// in `services::export` (`authorize_export_dest`), `services::workspace`
/// (`authorize_write`), and `services::stream` (`authorize_save_dest`) —
/// each of those modules had converged on the same allowlist +
/// parent-containment + path-hygiene logic for an agent-supplied write
/// destination. This is now the one place that answers the question.
///
/// A missing parent directory and a parent outside the allowlist collapse
/// into the identical `Forbidden`/`NOT_ALLOWED` refusal — same anti-probing
/// rationale as [`authorize_open`]: an agent must not be able to tell "does
/// not exist" from "not permitted" by probing paths.
pub fn authorize_write_dest(ctx: &ServiceCtx, raw: &str) -> Result<PathBuf, ServiceError> {
    use crate::commands::bridge_access::{validate_open_path, OpenAccessError};

    let path = std::path::Path::new(raw);

    if matches!(ctx.caller(), Caller::Ui) {
        return Ok(crate::simplified_path(path));
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| ServiceError::InvalidArg {
            code: INVALID_PATH,
            message: "destination must name a file".to_string(),
        })?;
    if file_name.contains(':') {
        return Err(ServiceError::InvalidArg {
            code: INVALID_PATH,
            message: "alternate data stream paths are not allowed".to_string(),
        });
    }

    let parent = path.parent().ok_or_else(|| ServiceError::InvalidArg {
        code: INVALID_PATH,
        message: "destination has no parent directory".to_string(),
    })?;
    let parent_str = parent.to_str().ok_or_else(|| ServiceError::InvalidArg {
        code: INVALID_PATH,
        message: "destination path is not valid UTF-8".to_string(),
    })?;

    let state = ctx.state();
    let (allowed, allow_all): (Vec<String>, bool) = {
        let cfg = state
            .mcp_open_allowlist
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (cfg.allowed_dirs.clone(), cfg.allow_all)
    };

    match validate_open_path(&allowed, &[], parent_str, allow_all) {
        Ok(canonical_parent) => Ok(canonical_parent.join(file_name)),
        Err(OpenAccessError::NotAllowed) => Err(ServiceError::Forbidden {
            code: NOT_ALLOWED,
            message: "path is not allowed".to_string(),
        }),
        Err(OpenAccessError::InvalidPath(msg)) => Err(ServiceError::InvalidArg {
            code: INVALID_PATH,
            message: msg,
        }),
    }
}

/// Refuse a gate-widening mutation from an agent.
///
/// An agent may not edit the open-file allowlist or the anonymizer config: a
/// caller must never be able to widen the gate that constrains it. Adapters
/// call this before any settings mutation.
pub fn deny_agent_gate_mutation(ctx: &ServiceCtx, what: &str) -> Result<(), ServiceError> {
    match ctx.caller() {
        Caller::Ui => Ok(()),
        Caller::Agent { .. } => Err(ServiceError::not_allowed(format!(
            "agents may not modify {what}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Anonymization gate
// ---------------------------------------------------------------------------

/// Read the persisted agent raw-access opt-out (`AppState::agent_raw_access`).
///
/// `false` — the default, and the value on a missing/corrupt settings file —
/// means agents are anonymized. Kept private: every decision about raw text
/// goes through [`should_anonymize_for`], and the *setting* is read/written
/// through `services::settings`.
fn agent_raw_access_enabled(state: &AppState) -> bool {
    *state
        .agent_raw_access
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Read the persisted anonymizer mode (`AnonymizerConfig::mode`).
///
/// Every decision about raw text goes through [`should_anonymize_for`]; the
/// *setting* is read/written through `services::settings` (the config is the
/// one persisted document, and `set_anonymizer_config` is its one `Ui`-only
/// writer).
pub fn anonymizer_mode(state: &AppState) -> AnonymizerMode {
    state
        .anonymizer_config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .mode
}

/// Where raw text is headed, as far as the anonymizer is concerned.
///
/// Every service that hands out raw log text names its pathway once, at the
/// decision site, and inherits the mode table from there — a new surface
/// never re-derives the rule. The classification is about the *destination*,
/// not the transport: a `Ui` viewer page is `Internal`; an `.lts` export, a
/// stream save-to-file or the clipboard is `External` even though the same
/// `Ui` caller asked for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pathway {
    /// Stays inside the app: viewer pages, search/filter results, pipeline
    /// result lines, stream batches to a pane, the in-chain anonymizer of a
    /// `Ui`-started stream.
    Internal,
    /// Leaves the tool: `.lts` export, stream save-to-file, clipboard /
    /// bookmark Markdown (`services::settings::anonymize_text`), analysis
    /// hand-off exports.
    External,
}

/// Must raw text on `pathway` be redacted for this caller?
///
/// The one place mode + identity become a redaction decision:
///
/// | mode       | `Ui` Internal | `Ui` External | `Agent` (either pathway)   |
/// |------------|---------------|---------------|----------------------------|
/// | `All`      | yes           | yes           | yes, unless raw access     |
/// | `External` | no            | yes           | yes, unless raw access     |
/// | `None`     | no            | no            | no                         |
///
/// An agent is outside the tool by definition, so its pathway never matters;
/// `None` means none everywhere — agents included — which is acceptable only
/// because both inputs are persisted `Ui`-only settings with a persistent,
/// visible warning in the app (the same consent class as `agent_raw_access`).
pub fn should_anonymize_for(ctx: &ServiceCtx, pathway: Pathway) -> bool {
    let mode = anonymizer_mode(ctx.state());
    match ctx.caller() {
        Caller::Agent { .. } => {
            mode != AnonymizerMode::None && !agent_raw_access_enabled(ctx.state())
        }
        Caller::Ui => match pathway {
            Pathway::Internal => mode == AnonymizerMode::All,
            Pathway::External => mode != AnonymizerMode::None,
        },
    }
}

/// Must this caller's in-app view of log text be redacted?
///
/// The [`Pathway::Internal`] shorthand of [`should_anonymize_for`] — every
/// read path (lines, search, filters, pipeline results, stream events, the
/// in-chain `__pii_anonymizer`) is `Internal`, so the existing call sites keep
/// this signature. `session_id` is accepted (and ignored) so every raw-text
/// call site keeps naming the session it is about — the decision is
/// deliberately global, so nothing a session carries (its pipeline chain above
/// all) can change what an agent is allowed to see.
pub fn should_anonymize(ctx: &ServiceCtx, _session_id: &str) -> bool {
    should_anonymize_for(ctx, Pathway::Internal)
}

/// The single choke point for raw log text leaving the backend, one line at a
/// time.
///
/// Every service that returns line text — lines, search, pipeline matched
/// lines, insights, section previews, stream batches, filters, export — routes
/// through here or [`redact_lines`]. Anonymize first, truncate second: see
/// [`anonymize_scan_line`] for why that order is load-bearing.
pub fn redact_line(ctx: &ServiceCtx, session_id: &str, raw: &str, max_chars: usize) -> String {
    if !should_anonymize(ctx, session_id) {
        return truncate_str(raw, max_chars);
    }
    anonymize_scan_line(ctx.state(), session_id, raw, max_chars)
}

/// [`redact_line`] for a whole page: same decision, same
/// anonymize-then-truncate order, but the anonymizer's locks are taken once
/// per call instead of once per line (see [`anonymize_session_lines`]). Every
/// element of `lines` is redacted in place, in order — order matters, because
/// token numbering follows first sight.
///
/// Never call this while holding `sessions`; collect the raw text, drop that
/// lock, then redact — the same rule as `redact_line`.
pub fn redact_lines(ctx: &ServiceCtx, session_id: &str, lines: &mut [String], max_chars: usize) {
    if should_anonymize(ctx, session_id) {
        anonymize_session_lines(ctx.state(), session_id, lines);
    }
    if max_chars != usize::MAX {
        for line in lines.iter_mut() {
            if line.chars().count() > max_chars {
                *line = truncate_str(line, max_chars);
            }
        }
    }
}

/// Apply `session_id`'s anonymizer to `raw`, unconditionally.
///
/// This is the *mechanism*, not the decision — [`should_anonymize`] owns the
/// decision and [`redact_line`] is the choke point that pairs the two. Reuses
/// this session's persistent `LogAnonymizer` — cached in `mcp_anonymizers` —
/// so token numbering stays stable across multiple bridge calls, creating one
/// from the current default `anonymizer_config` on first use.
///
/// Locks `anonymizer_config` then `mcp_anonymizers`, each acquired and
/// released in turn. Never held across an `.await`; never nested with
/// `sessions` or `pipeline_results`. Enforced at every call site: `h_query`,
/// `h_search`, `h_search_with_context`, and `h_lines_around` all collect RAW
/// text under the `sessions` lock first, drop it, and only then call this
/// function (via [`anonymize_scan_line`] / [`redact_line`]) — `sessions` is
/// never held while this function's own locks are acquired.
pub fn anonymize_session_text(state: &AppState, session_id: &str, raw: &str) -> String {
    let mut one = [raw.to_string()];
    anonymize_session_lines(state, session_id, &mut one);
    let [out] = one;
    out
}

/// Apply `session_id`'s anonymizer to every element of `lines`, in place and
/// in order, unconditionally — the batch form of [`anonymize_session_text`].
///
/// Acquires `anonymizer_config` then `mcp_anonymizers` **once** for the whole
/// batch: a viewer page under `All` redacts a few hundred lines per scroll,
/// and per-line locking (plus a per-line clone of the detector config) was
/// the cost that made the single-line helper unsuitable for that path. Same
/// cached per-session `LogAnonymizer`, same token numbering, same lock-order
/// rule (never nested under `sessions`).
pub fn anonymize_session_lines(state: &AppState, session_id: &str, lines: &mut [String]) {
    if lines.is_empty() {
        return;
    }
    let config = state
        .anonymizer_config
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let mut anon_map = state
        .mcp_anonymizers
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let anon = anon_map
        .entry(session_id.to_string())
        .or_insert_with(|| LogAnonymizer::from_config(&config));
    for line in lines.iter_mut() {
        *line = anon.anonymize(line).0;
    }
}

/// Truncate a string to at most `max_chars` characters, appending "..." if cut.
/// Uses char boundaries to avoid splitting multi-byte UTF-8 sequences.
pub fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let end = s.char_indices().nth(max_chars).map_or(s.len(), |(i, _)| i);
        let mut t = s[..end].to_string();
        t.push_str("...");
        t
    }
}

/// Anonymize + truncate a single raw line's text for MCP scan-result output,
/// via [`anonymize_session_text`]. Truncation is applied AFTER anonymization
/// so a redaction token is never cut mid-token by the length cap.
///
/// Reached through [`redact_line`] by `h_search` (matched line +
/// context_before/context_after), `h_search_with_context` (context lines) and
/// `h_lines_around` (each returned line) — all of which call it AFTER the
/// `sessions` lock used to collect the raw text has been dropped. Factored out
/// as a pure function (no locking beyond what `anonymize_session_text` itself
/// does) so the transformation is unit-testable without a live Tauri
/// `AppHandle`.
pub fn anonymize_scan_line(
    state: &AppState,
    session_id: &str,
    raw: &str,
    max_chars: usize,
) -> String {
    let clean = anonymize_session_text(state, session_id, raw);
    truncate_str(&clean, max_chars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;

    // ── should_anonymize_for (mode × pathway × caller) ──────────────────────
    // The whole truth table, one row per cell. Agents: anonymized unless the
    // mode is `None` or the user persisted the `agent_raw_access` opt-out —
    // their pathway never matters. Ui: `Internal` only under `All`,
    // `External` under anything but `None`. No session-level state — above
    // all no pipeline chain — participates.

    fn decide(caller_is_agent: bool, raw_access: bool, mode: AnonymizerMode, pathway: Pathway) -> bool {
        let mut b = test_ctx().anonymizer_mode(mode).agent_raw_access(raw_access);
        if caller_is_agent {
            b = b.agent("mcp");
        }
        let (ctx, _tmp) = b.build();
        should_anonymize_for(&ctx, pathway)
    }

    #[test]
    fn mode_table_ui_internal() {
        assert!(decide(false, false, AnonymizerMode::All, Pathway::Internal), "All: the viewer is anonymized");
        assert!(!decide(false, false, AnonymizerMode::External, Pathway::Internal), "External: the viewer is raw");
        assert!(!decide(false, false, AnonymizerMode::None, Pathway::Internal));
    }

    #[test]
    fn mode_table_ui_external() {
        assert!(decide(false, false, AnonymizerMode::All, Pathway::External));
        assert!(decide(false, false, AnonymizerMode::External, Pathway::External), "External: what leaves the tool is anonymized");
        assert!(!decide(false, false, AnonymizerMode::None, Pathway::External), "None means none — exports too");
    }

    #[test]
    fn mode_table_agent_without_raw_access() {
        for pathway in [Pathway::Internal, Pathway::External] {
            assert!(decide(true, false, AnonymizerMode::All, pathway));
            assert!(decide(true, false, AnonymizerMode::External, pathway));
            assert!(!decide(true, false, AnonymizerMode::None, pathway), "None means none — agents included");
        }
    }

    #[test]
    fn mode_table_agent_with_raw_access() {
        // The opt-out wins in every mode; the pathway still never matters.
        for pathway in [Pathway::Internal, Pathway::External] {
            for mode in [AnonymizerMode::All, AnonymizerMode::External, AnonymizerMode::None] {
                assert!(!decide(true, true, mode, pathway), "{mode:?}/{pathway:?}: raw access must yield raw text");
            }
        }
    }

    #[test]
    fn ui_raw_access_flag_is_irrelevant_to_a_ui_caller() {
        // `agent_raw_access` is about agents; it neither widens nor narrows
        // what the user's own app shows or exports.
        assert!(decide(false, true, AnonymizerMode::All, Pathway::Internal));
        assert!(decide(false, true, AnonymizerMode::External, Pathway::External));
        assert!(!decide(false, true, AnonymizerMode::External, Pathway::Internal));
    }

    #[test]
    fn the_default_mode_is_external() {
        // A fresh state (no config file) behaves exactly as before the mode
        // existed: Ui raw in-app, agents redacted.
        let (ui, _t1) = test_ctx().build();
        assert!(!should_anonymize(&ui, "s1"));
        assert!(should_anonymize_for(&ui, Pathway::External));
        let (agent, _t2) = test_ctx().agent("mcp").build();
        assert!(should_anonymize(&agent, "s1"));
    }

    #[test]
    fn should_anonymize_is_the_internal_shorthand() {
        for mode in [AnonymizerMode::All, AnonymizerMode::External, AnonymizerMode::None] {
            for agent in [false, true] {
                let mut b = test_ctx().anonymizer_mode(mode);
                if agent {
                    b = b.agent("mcp");
                }
                let (ctx, _tmp) = b.build();
                assert_eq!(should_anonymize(&ctx, "any"), should_anonymize_for(&ctx, Pathway::Internal));
            }
        }
    }

    #[test]
    fn the_rule_is_global_not_per_session() {
        // Every session answers the same way — the old map could (and did)
        // disagree between two sessions sharing the same bridge traffic.
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        assert!(should_anonymize(&ctx, "sess-a"));
        assert!(should_anonymize(&ctx, "never-seen"));

        let (raw_ctx, _tmp2) = test_ctx().agent("mcp").agent_raw_access(true).build();
        assert!(!should_anonymize(&raw_ctx, "sess-a"));
        assert!(!should_anonymize(&raw_ctx, "never-seen"));
    }

    // ── anonymize_session_text / anonymize_session_lines (the mechanism) ────
    // Unconditional: the decision belongs to `should_anonymize_for`, and
    // `redact_line` / `redact_lines` are the places that pair the two.

    #[test]
    fn anonymize_session_lines_matches_the_per_line_helper() {
        // Same anonymizer, same numbering: a page redacted in one lock must be
        // byte-identical to the same lines redacted one call at a time.
        let per_line_state = AppState::new();
        let batch_state = AppState::new();
        let lines = vec![
            "a user@example.com".to_string(),
            "b 10.0.0.1 then user@example.com".to_string(),
            "c nothing here".to_string(),
            "d other@example.org".to_string(),
        ];
        let expected: Vec<String> = lines
            .iter()
            .map(|l| anonymize_session_text(&per_line_state, "s", l))
            .collect();
        let mut batch = lines.clone();
        anonymize_session_lines(&batch_state, "s", &mut batch);
        assert_eq!(batch, expected);
        assert!(!batch.iter().any(|l| l.contains("@example")), "{batch:?}");
        assert_eq!(batch[2], "c nothing here");
    }

    #[test]
    fn anonymize_session_lines_shares_numbering_with_later_single_calls() {
        let state = AppState::new();
        let mut batch = vec!["first user@example.com".to_string()];
        anonymize_session_lines(&state, "s", &mut batch);
        let token = batch[0].split_whitespace().last().unwrap().to_string();
        let later = anonymize_session_text(&state, "s", "again user@example.com");
        assert!(later.ends_with(&token), "numbering drifted between batch and single: {later} vs {token}");
    }

    #[test]
    fn redact_lines_truncates_after_anonymizing_and_leaves_ui_text_alone() {
        let (agent, _t1) = test_ctx().agent("mcp").build();
        let long = format!("{} user@example.com", "p".repeat(489));
        let mut lines = vec![long.clone(), "short".to_string()];
        redact_lines(&agent, "s1", &mut lines, 500);
        assert!(!lines[0].contains("user@"), "anonymize first, then cut: {}", lines[0]);
        assert_eq!(lines[1], "short");

        let (ui, _t2) = test_ctx().build();
        let mut lines = vec![long.clone()];
        redact_lines(&ui, "s1", &mut lines, usize::MAX);
        assert_eq!(lines[0], long, "External mode: the Ui's in-app text is untouched");
    }

    #[test]
    fn anonymize_session_text_always_redacts() {
        let state = AppState::new();
        let raw = "contact user@example.com for access";
        let out = anonymize_session_text(&state, "sess-a", raw);
        assert_ne!(out, raw);
        assert!(!out.contains("user@example.com"));
    }

    #[test]
    fn anonymize_session_text_reuses_one_anonymizer_per_session() {
        // Token numbering must stay stable across calls — an agent that saw
        // <EMAIL-1> in a search hit must see the same token in lines_around.
        let state = AppState::new();
        let a = anonymize_session_text(&state, "sess-a", "contact user@example.com");
        let b = anonymize_session_text(&state, "sess-a", "again: user@example.com");
        let token = a.split_whitespace().last().unwrap();
        assert!(b.contains(token), "token numbering drifted: {a} / {b}");
    }

    // ── anonymize_scan_line (h_search / h_search_with_context / h_lines_around) ─
    // These three handlers used to call the anonymizer WHILE still holding the
    // `sessions` lock from their chunked scan loop — a lock-order violation of
    // the bridge's own header rule ("copy/clone the data needed, drop the
    // `sessions` lock, THEN build the JSON response"). The fix moves
    // anonymization to run after `sessions` is dropped, funneled through this
    // shared helper.

    #[test]
    fn anonymize_scan_line_redacts_pii() {
        let state = AppState::new();
        let raw = "contact user@example.com for access";
        let out = anonymize_scan_line(&state, "sess-a", raw, 500);
        assert_ne!(out, raw);
        assert!(!out.contains("user@example.com"), "raw PII leaked: {out}");
    }

    #[test]
    fn anonymize_scan_line_anonymizes_before_truncating() {
        // Order matters: anonymize the FULL raw text first, then truncate.
        // If it were truncated first, an email straddling the cut point would
        // be sliced mid-token (e.g. "user@example." with no TLD) — the
        // anonymizer's email pattern would no longer match the mangled
        // fragment, and the "user@" prefix would leak unredacted.
        //
        // Email spans char 490..506 — straddles the 500-char truncation point.
        // The prefix ends in a space so the email sits on a word boundary
        // (EMAIL_RE is `\b`-anchored with a bounded local part).
        let state = AppState::new();
        let long_line = format!("{} user@example.com", "p".repeat(489));
        let out = anonymize_scan_line(&state, "sess-a", &long_line, 500);
        assert!(!out.contains("user@"), "partial/full email leaked: {out}");
    }

    #[test]
    fn anonymize_scan_line_respects_a_custom_cap() {
        // h_search_with_context accepts a caller-supplied `max_line_chars`
        // (up to 8000) instead of the fixed 500 h_search/h_lines_around use —
        // verify the cap is still honored post-anonymization.
        let state = AppState::new();
        let long = "x".repeat(600);
        let out = anonymize_scan_line(&state, "sess-a", &long, 500);
        assert!(out.ends_with("..."));
        assert_eq!(out.chars().count(), 503);
    }

    // ── truncate_str (moved here with the helpers that use it) ──────────────

    #[test]
    fn truncate_str_leaves_short_lines_untouched() {
        assert_eq!(truncate_str("short", 500), "short");
        let exact = "x".repeat(500);
        assert_eq!(truncate_str(&exact, 500), exact);
    }

    #[test]
    fn truncate_str_cuts_and_marks_long_lines() {
        let long = "y".repeat(600);
        let out = truncate_str(&long, 500);
        assert!(out.ends_with("..."));
        assert_eq!(out.chars().count(), 503);
    }

    #[test]
    fn truncate_str_respects_a_wider_cap() {
        // A realistic UsbPortStatus line: the fields that decide a diagnosis
        // (canChangeDataRole, lastConnectDurationMillis) sit past char 500, so
        // `h_search_with_context`'s caller-supplied `max_line_chars` must be
        // honoured all the way down here.
        let line = format!(
            "{}canChangeDataRole=false, lastConnectDurationMillis=0",
            "p".repeat(520)
        );
        assert!(!truncate_str(&line, 500).contains("canChangeDataRole"));
        let wide = truncate_str(&line, 8000);
        assert!(wide.contains("canChangeDataRole=false"));
        assert!(wide.contains("lastConnectDurationMillis=0"));
        assert!(!wide.ends_with("..."));
    }

    #[test]
    fn truncate_str_does_not_split_multibyte_chars() {
        let s = "日本語テキスト";
        let out = truncate_str(s, 4);
        assert_eq!(out, "日本語テ...");
    }

    // ── Caller-aware gates ─────────────────────────────────────────────────

    #[test]
    fn ui_caller_is_never_anonymized() {
        // The user is looking at their own machine's logs in their own app.
        // The gate exists to bound what leaves for an AGENT.
        let (ctx, _tmp) = test_ctx().with_session("s1", 1).build();
        assert!(!should_anonymize(&ctx, "s1"));
        let out = redact_line(&ctx, "s1", "contact user@example.com", 500);
        assert_eq!(out, "contact user@example.com");
    }

    #[test]
    fn agent_caller_is_redacted_with_no_configuration_at_all() {
        // The default state of a fresh install: no settings file, no opt-out.
        let (ctx, _tmp) = test_ctx().caller(Caller::Agent { client: "mcp".into() }).build();
        assert!(should_anonymize(&ctx, "never-seen"));
        let out = redact_line(&ctx, "never-seen", "contact user@example.com", 500);
        assert!(!out.contains("user@example.com"), "raw PII leaked: {out}");
    }

    #[test]
    fn agent_caller_gets_raw_text_only_after_the_user_opted_out() {
        let (ctx, _tmp) = test_ctx()
            .caller(Caller::Agent { client: "mcp".into() })
            .agent_raw_access(true)
            .build();
        assert!(!should_anonymize(&ctx, "s1"));
        assert_eq!(
            redact_line(&ctx, "s1", "contact user@example.com", 500),
            "contact user@example.com"
        );
    }

    #[test]
    fn redact_line_truncates_for_a_ui_caller_too() {
        // No anonymization for the UI, but the character cap still applies —
        // otherwise the two callers would get differently-shaped responses.
        let (ctx, _tmp) = test_ctx().build();
        let long = "z".repeat(600);
        let out = redact_line(&ctx, "s1", &long, 500);
        assert!(out.ends_with("..."));
        assert_eq!(out.chars().count(), 503);
    }

    #[test]
    fn redact_line_anonymizes_before_truncating_for_an_agent() {
        let (ctx, _tmp) = test_ctx()
            .caller(Caller::Agent { client: "mcp".into() })
            .build();
        let long_line = format!("{} user@example.com", "p".repeat(489));
        let out = redact_line(&ctx, "s1", &long_line, 500);
        assert!(!out.contains("user@"), "partial/full email leaked: {out}");
    }

    // ── authorize_open ─────────────────────────────────────────────────────

    #[test]
    fn authorize_open_denies_an_agent_by_default() {
        // Default-deny: an empty allowlist permits nothing.
        let (ctx, tmp) = test_ctx().caller(Caller::Agent { client: "mcp".into() }).build();
        let f = tmp.path().join("some.log");
        std::fs::write(&f, "x").unwrap();
        let err = authorize_open(&ctx, &f.to_string_lossy()).unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert_eq!(err.http_status(), 403);
        assert_eq!(err.message(), "path is not allowed");
    }

    #[test]
    fn authorize_open_denied_and_nonexistent_are_indistinguishable() {
        // A client must not be able to probe the filesystem through this
        // error — the two cases share a byte-identical refusal.
        let (ctx, tmp) = test_ctx().caller(Caller::Agent { client: "mcp".into() }).build();
        let real = tmp.path().join("real.log");
        std::fs::write(&real, "x").unwrap();
        let missing = tmp.path().join("missing.log");

        let a = authorize_open(&ctx, &real.to_string_lossy()).unwrap_err();
        let b = authorize_open(&ctx, &missing.to_string_lossy()).unwrap_err();
        assert_eq!(a, b);
    }

    #[test]
    fn authorize_open_permits_an_agent_inside_the_allowlist() {
        let (ctx, tmp) = {
            let b = test_ctx().caller(Caller::Agent { client: "mcp".into() });
            let (ctx, tmp) = b.build();
            (ctx, tmp)
        };
        let f = tmp.path().join("allowed.log");
        std::fs::write(&f, "x").unwrap();
        ctx.state()
            .mcp_open_allowlist
            .lock()
            .unwrap()
            .allowed_dirs
            .push(tmp.path().to_string_lossy().to_string());

        let ok = authorize_open(&ctx, &f.to_string_lossy()).expect("inside the allowlist");
        assert!(ok.to_string_lossy().to_lowercase().contains("allowed.log"));
    }

    #[test]
    fn authorize_open_passes_a_ui_caller_through_without_an_allowlist() {
        // The native file dialog is the consent step — the UI never consults
        // the agent allowlist.
        let (ctx, tmp) = test_ctx().build();
        let f = tmp.path().join("ui.log");
        std::fs::write(&f, "x").unwrap();
        let ok = authorize_open(&ctx, &f.to_string_lossy()).expect("ui always allowed");
        assert!(ok.to_string_lossy().to_lowercase().contains("ui.log"));
    }

    #[test]
    fn authorize_open_rejects_a_malformed_path_as_invalid_not_forbidden() {
        let (ctx, _tmp) = test_ctx().caller(Caller::Agent { client: "mcp".into() }).build();
        let err = authorize_open(&ctx, "relative/path.log").unwrap_err();
        assert_eq!(err.code(), "INVALID_PATH");
        assert_eq!(err.http_status(), 400);
    }

    // ── authorize_write_dest ───────────────────────────────────────────────

    #[test]
    fn authorize_write_dest_ui_passes_through_unconditionally() {
        let (ctx, _tmp) = test_ctx().build();
        let dest = authorize_write_dest(&ctx, "C:\\anywhere\\at\\all.ltw").expect("ui may write anywhere");
        assert_eq!(dest, PathBuf::from("C:\\anywhere\\at\\all.ltw"));
    }

    #[test]
    fn authorize_write_dest_agent_denies_by_default() {
        let (ctx, tmp) = test_ctx().agent("mcp").build();
        let dest = tmp.path().join("out.dat");
        let err = authorize_write_dest(&ctx, &dest.to_string_lossy()).unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert_eq!(err.http_status(), 403);
    }

    #[test]
    fn authorize_write_dest_agent_permits_a_new_file_inside_an_allowed_directory() {
        let allowed = tempfile::tempdir().expect("allowlisted dir");
        let (ctx, _tmp) = test_ctx().agent("mcp").allowlist(allowed.path()).build();

        // The destination FILE does not exist yet — only the parent directory
        // must exist and be inside the allowlist.
        let dest = allowed.path().join("new-file.dat");
        let ok = authorize_write_dest(&ctx, &dest.to_string_lossy()).expect("inside the allowlist");
        assert_eq!(ok.file_name().unwrap(), "new-file.dat");
    }

    #[test]
    fn authorize_write_dest_agent_denies_outside_the_allowlist() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        let outside = tempfile::tempdir().expect("outside dir");
        let dest = outside.path().join("x.dat");
        let err = authorize_write_dest(&ctx, &dest.to_string_lossy())
            .expect_err("outside the allowlist must be refused");
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn authorize_write_dest_agent_rejects_a_relative_path_as_invalid_not_forbidden() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        let err = authorize_write_dest(&ctx, "relative/out.dat").unwrap_err();
        assert_eq!(err.code(), "INVALID_PATH");
        assert_eq!(err.http_status(), 400);
    }

    #[test]
    fn authorize_write_dest_agent_denies_when_the_parent_directory_does_not_exist() {
        let allowed = tempfile::tempdir().expect("allowlisted dir");
        let (ctx, _tmp) = test_ctx().agent("mcp").allowlist(allowed.path()).build();
        let dest = allowed.path().join("does-not-exist").join("out.dat");
        let err = authorize_write_dest(&ctx, &dest.to_string_lossy()).unwrap_err();
        // Same refusal shape as "outside the allowlist" — no probing signal.
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn authorize_write_dest_agent_rejects_an_alternate_data_stream_file_name() {
        let allowed = tempfile::tempdir().expect("allowlisted dir");
        let (ctx, _tmp) = test_ctx().agent("mcp").allowlist(allowed.path()).build();
        let dest = format!("{}\\ok.dat:evil", allowed.path().to_string_lossy());
        let err = authorize_write_dest(&ctx, &dest).expect_err("ADS suffix must be refused");
        assert_eq!(err.code(), "INVALID_PATH");
    }

    #[test]
    fn agents_may_not_widen_their_own_gate() {
        let (agent_ctx, _t1) = test_ctx().caller(Caller::Agent { client: "mcp".into() }).build();
        let err = deny_agent_gate_mutation(&agent_ctx, "the open-file allowlist").unwrap_err();
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert_eq!(err.message(), "agents may not modify the open-file allowlist");

        let (ui_ctx, _t2) = test_ctx().build();
        assert!(deny_agent_gate_mutation(&ui_ctx, "the open-file allowlist").is_ok());
    }
}
