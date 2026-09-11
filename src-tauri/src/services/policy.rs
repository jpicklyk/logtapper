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
//! - [`should_anonymize`] — must this caller's view of this session be redacted?
//! - [`redact_line`] — the single choke point every raw-text response goes through.
//!
//! The anonymization helpers below (`anonymize_session_text`,
//! `anonymize_scan_line`, `truncate_str`) were moved here from `mcp_bridge.rs`
//! with their tests, and the bridge calls them from here. Their
//! anonymize-before-truncate contract is unchanged and still pinned by those
//! tests — it is the difference between an agent seeing a redacted log and an
//! agent seeing a user's email address.
//!
//! **Anonymization is a single global decision, not a per-session one.** An
//! agent is anonymized unless `AppState::agent_raw_access` is `true` — one
//! persisted, UI-only opt-out (`services::settings::set_agent_raw_access`).
//! The per-session `mcp_anonymize` map this replaced was mirrored from each
//! session's pipeline chain by the frontend, which meant the default chain
//! silently turned agent anonymization *off*.

use std::path::PathBuf;

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
/// goes through [`should_anonymize`], and the *setting* is read/written
/// through `services::settings`.
fn agent_raw_access_enabled(state: &AppState) -> bool {
    *state
        .agent_raw_access
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Must this caller's view of log text be redacted?
///
/// - `Ui` → `false`, always. The user is looking at their own machine's logs
///   in their own app.
/// - `Agent` → `!agent_raw_access`. Anonymized by default; raw only when the
///   user explicitly opted out in Settings → General → MCP Integration.
///
/// `session_id` is accepted (and ignored) so every raw-text call site keeps
/// naming the session it is about — the decision is deliberately global, so
/// nothing a session carries (its pipeline chain above all) can change what an
/// agent is allowed to see.
///
/// `services::export` is the one caller that does NOT use this function to
/// decide a `Ui` export's redaction: `.lts` export has its own explicit,
/// per-export "Anonymize PII" checkbox (`ExportAllOptions::anonymize`,
/// `services::export::should_anonymize_export`) — ticking it calls
/// [`anonymize_session_text`] directly rather than going through this
/// caller-only decision, since a `Ui` caller always resolves to `false` here.
/// An `Agent` export still funnels through this function unchanged; the
/// checkbox is silently ignored for that caller.
pub fn should_anonymize(ctx: &ServiceCtx, _session_id: &str) -> bool {
    match ctx.caller() {
        Caller::Ui => false,
        Caller::Agent { .. } => !agent_raw_access_enabled(ctx.state()),
    }
}

/// The single choke point for raw log text leaving the backend.
///
/// Every service that returns line text — lines, search, pipeline matched
/// lines, insights, section previews, stream batches, filters, export — routes
/// through here. Anonymize first, truncate second: see [`anonymize_scan_line`]
/// for why that order is load-bearing.
pub fn redact_line(ctx: &ServiceCtx, session_id: &str, raw: &str, max_chars: usize) -> String {
    if !should_anonymize(ctx, session_id) {
        return truncate_str(raw, max_chars);
    }
    anonymize_scan_line(ctx.state(), session_id, raw, max_chars)
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
    anon.anonymize(raw).0
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

    // ── should_anonymize (the agent raw-access rule) ────────────────────────
    // Replaces the per-session `mcp_anonymize` fail-closed map: anonymization
    // for agents is ON unless the user persisted the `agent_raw_access`
    // opt-out. No session-level state — above all no pipeline chain — can
    // change what an agent is allowed to see.

    #[test]
    fn agent_is_anonymized_by_default() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        assert!(should_anonymize(&ctx, "s1"));
    }

    #[test]
    fn agent_is_anonymized_for_a_session_that_was_never_seen() {
        // There is nothing to "signal" any more — an unknown session id is
        // exactly as redacted as a known one.
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        assert!(should_anonymize(&ctx, "never-seen"));
    }

    #[test]
    fn agent_gets_raw_text_only_when_raw_access_is_enabled() {
        let (ctx, _tmp) = test_ctx().agent("mcp").agent_raw_access(true).build();
        assert!(!should_anonymize(&ctx, "s1"));
    }

    #[test]
    fn the_rule_is_global_not_per_session() {
        // Every session answers the same way — the old map could (and did)
        // disagree between two sessions sharing the same bridge traffic.
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        assert!(should_anonymize(&ctx, "sess-a"));
        assert!(should_anonymize(&ctx, "sess-b"));

        let (raw_ctx, _tmp2) = test_ctx().agent("mcp").agent_raw_access(true).build();
        assert!(!should_anonymize(&raw_ctx, "sess-a"));
        assert!(!should_anonymize(&raw_ctx, "sess-b"));
    }

    #[test]
    fn ui_is_never_anonymized_in_either_state() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(!should_anonymize(&ctx, "s1"));
        let (ctx, _tmp) = test_ctx().agent_raw_access(true).build();
        assert!(!should_anonymize(&ctx, "s1"));
    }

    // ── anonymize_session_text (the mechanism) ──────────────────────────────
    // Unconditional: the decision belongs to `should_anonymize`, and
    // `redact_line` is the one place that pairs the two.

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
