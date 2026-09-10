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
//! The anonymization helpers below (`resolve_should_anonymize`,
//! `anonymize_for_session`, `anonymize_line_texts`, `anonymize_scan_line`,
//! `truncate_str`) were moved here verbatim from `mcp_bridge.rs`, with their
//! tests, and the bridge now calls them from here. Their fail-closed and
//! anonymize-before-truncate contracts are unchanged and still pinned by those
//! tests — they are the difference between an agent seeing a redacted log and
//! an agent seeing a user's email address.

use std::collections::HashMap;
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

/// Resolve whether MCP bridge responses for `session_id` should be
/// anonymized, given the current per-session flag map (`AppState::mcp_anonymize`).
///
/// **Fails closed**: a session with no explicit entry — one the frontend has
/// never signalled a pipeline-chain state for (e.g. just opened, or the
/// signal hasn't landed yet) — defaults to `true`. Serving raw PII for an
/// unrecognized session is the wrong default; over-anonymizing a session
/// that didn't need it is not.
///
/// Pulled out as a pure function (no locking, no `AppState`) so the decision
/// itself is unit-testable without spinning up Axum or Tauri state.
///
/// Also reused by `commands::export::export_all_sessions` — export must gate
/// on the same per-session state as the bridge rather than inventing a
/// second anonymization decision, or the two could disagree about whether a
/// given session's raw text is safe to hand out.
pub fn resolve_should_anonymize(flags: &HashMap<String, bool>, session_id: &str) -> bool {
    flags.get(session_id).copied().unwrap_or(true)
}

/// Caller-aware form of [`resolve_should_anonymize`].
///
/// A `Ui` caller is the owner of the machine looking at their own logs — never
/// redacted. An `Agent` caller resolves the per-session flag, fail-closed.
pub fn should_anonymize(ctx: &ServiceCtx, session_id: &str) -> bool {
    match ctx.caller() {
        Caller::Ui => false,
        Caller::Agent { .. } => {
            let flags = ctx
                .state()
                .mcp_anonymize
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            resolve_should_anonymize(&flags, session_id)
        }
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

/// Anonymize `raw` for `session_id` per its resolved per-session flag (see
/// [`resolve_should_anonymize`]). Reuses this session's persistent
/// `LogAnonymizer` — cached in `mcp_anonymizers` — so token numbering stays
/// stable across multiple bridge calls, creating one from the current
/// default `anonymizer_config` on first use. Returns `raw` unchanged when
/// anonymization is disabled (or unset — never happens, since unset fails
/// closed to anonymize) for this session.
///
/// Locks `mcp_anonymize`, then (only when anonymizing) `anonymizer_config`
/// and `mcp_anonymizers`, each acquired and released in turn. Never held
/// across an `.await`; never nested with `sessions` or `pipeline_results`.
/// Enforced at every call site: `h_query`, `h_search`, `h_search_with_context`,
/// and `h_lines_around` all collect RAW text under the `sessions` lock first,
/// drop it, and only then call this function (directly or via
/// [`anonymize_scan_line`] / [`anonymize_line_texts`]) — `sessions` is never
/// held while this function's own locks are acquired.
///
/// Also called from `commands::export::export_all_sessions` (after its
/// `sessions` lock has been dropped, mirroring the `resolve_line_texts` /
/// `anonymize_line_texts` split in `mcp_bridge`) so exported `.lts` archives
/// honor the same per-session anonymization flag as MCP bridge reads, instead
/// of writing raw Tier-1 bytes unconditionally.
pub fn anonymize_for_session(state: &AppState, session_id: &str, raw: &str) -> String {
    let should_anonymize = {
        let flags = state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        resolve_should_anonymize(&flags, session_id)
    };
    if !should_anonymize {
        return raw.to_string();
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

/// Anonymize and truncate a map of line_num -> raw text produced by
/// `mcp_bridge::resolve_line_texts`, honoring the session's per-session
/// `mcp_anonymize` flag via [`anonymize_for_session`].
///
/// Must be called AFTER the `sessions` lock used by `resolve_line_texts` has
/// been dropped: `anonymize_for_session` acquires `mcp_anonymize` /
/// `anonymizer_config` / `mcp_anonymizers`, and nesting those under
/// `sessions` violates the lock-ordering rule in `mcp_bridge`'s module header.
///
/// Truncation (500 chars, matching `resolve_line_texts`'s historical
/// behavior) is applied AFTER anonymization so a redaction token is never
/// cut mid-token by the length cap.
pub fn anonymize_line_texts(
    state: &AppState,
    session_id: &str,
    raw: HashMap<usize, String>,
) -> HashMap<usize, String> {
    raw.into_iter()
        .map(|(ln, text)| {
            let anonymized = anonymize_for_session(state, session_id, &text);
            (ln, truncate_str(&anonymized, 500))
        })
        .collect()
}

/// Anonymize + truncate a single raw line's text for MCP scan-result output,
/// honoring the session's per-session `mcp_anonymize` flag via
/// [`anonymize_for_session`]. Truncation is applied AFTER anonymization (same
/// ordering rationale as [`anonymize_line_texts`]) so a redaction token is
/// never cut mid-token by the length cap.
///
/// Shared by `h_search` (matched line + context_before/context_after),
/// `h_search_with_context` (context lines), and `h_lines_around` (each
/// returned line) — all three call this AFTER the `sessions` lock used to
/// collect the raw text has been dropped, mirroring the `resolve_line_texts`
/// / `anonymize_line_texts` split in `mcp_bridge`. Factored out as a pure
/// function (no locking beyond what `anonymize_for_session` itself does) so
/// the transformation is unit-testable without a live Tauri `AppHandle`.
pub fn anonymize_scan_line(
    state: &AppState,
    session_id: &str,
    raw: &str,
    max_chars: usize,
) -> String {
    let clean = anonymize_for_session(state, session_id, raw);
    truncate_str(&clean, max_chars)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;

    // ── resolve_should_anonymize / anonymize_for_session ────────────────────
    // Ported verbatim from `mcp_bridge::tests` when these helpers moved here.
    // Per-session MCP anonymization flag: must fail closed on an unknown
    // session, and must not leak one session's raw-vs-anonymized state into
    // another's (the bug this gate fixes — see AppState::mcp_anonymize).

    #[test]
    fn resolve_should_anonymize_defaults_true_for_unknown_session() {
        // No entry at all — e.g. a session the frontend has never signalled
        // a pipeline-chain state for. Must fail closed to anonymize.
        let flags: HashMap<String, bool> = HashMap::new();
        assert!(resolve_should_anonymize(&flags, "unknown-session"));
    }

    #[test]
    fn resolve_should_anonymize_true_when_flag_set_true() {
        let mut flags: HashMap<String, bool> = HashMap::new();
        flags.insert("sess-a".to_string(), true);
        assert!(resolve_should_anonymize(&flags, "sess-a"));
    }

    #[test]
    fn resolve_should_anonymize_false_when_flag_set_false() {
        let mut flags: HashMap<String, bool> = HashMap::new();
        flags.insert("sess-a".to_string(), false);
        assert!(!resolve_should_anonymize(&flags, "sess-a"));
    }

    #[test]
    fn resolve_should_anonymize_is_per_session_not_global() {
        // The exact scenario from the bug report: two sessions, only one of
        // which has __pii_anonymizer active. A global bool could not
        // represent this; the per-session map must.
        let mut flags: HashMap<String, bool> = HashMap::new();
        flags.insert("sess-anonymized".to_string(), true);
        flags.insert("sess-raw".to_string(), false);
        assert!(resolve_should_anonymize(&flags, "sess-anonymized"));
        assert!(!resolve_should_anonymize(&flags, "sess-raw"));
    }

    #[test]
    fn anonymize_for_session_serves_raw_when_flag_false() {
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), false);
        let raw = "contact user@example.com for access";
        let out = anonymize_for_session(&state, "sess-a", raw);
        assert_eq!(out, raw);
    }

    #[test]
    fn anonymize_for_session_redacts_when_flag_true() {
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);
        let raw = "contact user@example.com for access";
        let out = anonymize_for_session(&state, "sess-a", raw);
        assert_ne!(out, raw);
        assert!(!out.contains("user@example.com"));
    }

    #[test]
    fn anonymize_for_session_fails_closed_for_unknown_session() {
        // No `set_mcp_anonymize` call has ever landed for this session —
        // must anonymize by default, not serve raw PII.
        let state = AppState::new();
        let raw = "contact user@example.com for access";
        let out = anonymize_for_session(&state, "never-seen-session", raw);
        assert_ne!(out, raw);
        assert!(!out.contains("user@example.com"));
    }

    // ── anonymize_line_texts (Tier-2 raw-line-leak fix) ──────────────────────
    // `h_pipeline` (reporter sampleMatchedLines / tracker recentTransitions)
    // and `h_processor_detail` (include_line_text=true) both resolve raw text
    // via `resolve_line_texts` and previously injected it straight into the
    // JSON response as `rawLine`, never checking the session's
    // `mcp_anonymize` flag — unlike h_query/h_search/h_lines_around/
    // h_search_with_context, which all route through `anonymize_for_session`.
    // These tests exercise the two-phase fix directly: `resolve_line_texts`
    // stays a pure "fetch under lock" helper, and `anonymize_line_texts` is
    // the gate callers must pipe its output through afterward.

    #[test]
    fn anonymize_line_texts_redacts_pii_when_flag_true() {
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);

        let mut raw = HashMap::new();
        raw.insert(10usize, "contact user@example.com for access".to_string());
        raw.insert(20usize, "no pii on this line".to_string());

        let out = anonymize_line_texts(&state, "sess-a", raw);

        // The PII-bearing line must no longer contain the raw email — this
        // is exactly the field `h_pipeline` / `h_processor_detail` inject
        // into `rawLine` in the JSON response.
        assert!(
            !out[&10].contains("user@example.com"),
            "raw PII leaked through rawLine: {}",
            out[&10]
        );
        assert_eq!(out[&20], "no pii on this line");
    }

    #[test]
    fn anonymize_line_texts_serves_raw_when_flag_false() {
        // Anonymization is opt-in per session — a session that explicitly
        // disabled it must still get its raw text back unchanged.
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-raw".to_string(), false);

        let mut raw = HashMap::new();
        raw.insert(5usize, "contact user@example.com for access".to_string());

        let out = anonymize_line_texts(&state, "sess-raw", raw);
        assert_eq!(out[&5], "contact user@example.com for access");
    }

    #[test]
    fn anonymize_line_texts_fails_closed_for_unknown_session() {
        // No `set_mcp_anonymize` signal has landed for this session yet —
        // must anonymize by default (same fail-closed contract as
        // `anonymize_for_session`), not serve raw PII through rawLine.
        let state = AppState::new();
        let mut raw = HashMap::new();
        raw.insert(1usize, "contact user@example.com for access".to_string());

        let out = anonymize_line_texts(&state, "never-seen-session", raw);
        assert!(!out[&1].contains("user@example.com"));
    }

    #[test]
    fn anonymize_line_texts_anonymizes_before_truncating() {
        // Order matters: anonymize the FULL raw text first, then truncate.
        // If it were truncated first, an email straddling the 500-char cut
        // point would be sliced mid-token (e.g. "user@example." with no
        // TLD) — the anonymizer's email pattern would no longer match the
        // mangled fragment, and the "user@" prefix would leak into rawLine
        // unredacted. Doing it in the right order redacts the whole email
        // before the cut ever happens.
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);

        // Email spans char 490..506 — straddles the 500-char truncation point.
        // The prefix ends in a space so the email sits on a word boundary
        // (EMAIL_RE is `\b`-anchored with a bounded local part; without a
        // boundary a 490-char word prefix would prevent any match at all,
        // which is unrelated to the ordering this test checks).
        let long_line = format!("{} user@example.com", "p".repeat(489));
        let mut raw = HashMap::new();
        raw.insert(1usize, long_line);

        let out = anonymize_line_texts(&state, "sess-a", raw);
        assert!(
            !out[&1].contains("user@"),
            "partial/full email leaked through rawLine: {}",
            out[&1]
        );
    }

    // ── anonymize_scan_line (h_search / h_search_with_context / h_lines_around) ─
    // These three handlers used to call `anonymize_for_session` (which locks
    // `mcp_anonymize` / `anonymizer_config` / `mcp_anonymizers`) WHILE still
    // holding the `sessions` lock from their chunked scan loop — a lock-order
    // violation of the bridge's own header rule ("copy/clone the data needed,
    // drop the `sessions` lock, THEN build the JSON response"). The fix moves
    // anonymization to run after `sessions` is dropped, funneled through this
    // shared helper.

    #[test]
    fn anonymize_scan_line_redacts_pii_when_flag_true() {
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);

        let raw = "contact user@example.com for access";
        let out = anonymize_scan_line(&state, "sess-a", raw, 500);
        assert_ne!(out, raw);
        assert!(!out.contains("user@example.com"), "raw PII leaked: {out}");
    }

    #[test]
    fn anonymize_scan_line_serves_raw_when_flag_false() {
        // Anonymization is opt-in per session — matches h_search's contract
        // of honoring the session's mcp_anonymize flag, not a global switch.
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-raw".to_string(), false);

        let raw = "contact user@example.com for access";
        let out = anonymize_scan_line(&state, "sess-raw", raw, 500);
        assert_eq!(out, raw);
    }

    #[test]
    fn anonymize_scan_line_fails_closed_for_unknown_session() {
        // No `set_mcp_anonymize` signal has landed for this session — must
        // anonymize by default (same fail-closed contract as
        // `anonymize_for_session` / `anonymize_line_texts`), matching what
        // h_search / h_search_with_context / h_lines_around must do for a
        // session the frontend hasn't signalled a state for yet.
        let state = AppState::new();
        let raw = "contact user@example.com for access";
        let out = anonymize_scan_line(&state, "never-seen-session", raw, 500);
        assert!(
            !out.contains("user@example.com"),
            "raw PII leaked for unrecognized session: {out}"
        );
    }

    #[test]
    fn anonymize_scan_line_anonymizes_before_truncating() {
        // Same ordering requirement as `anonymize_line_texts`: h_search's
        // matched line, its contextBefore/contextAfter lines, and
        // h_search_with_context's/h_lines_around's context lines are all
        // truncated at up to 500/max_line_chars characters — if truncation
        // ran first, an email straddling the cut point would be sliced
        // mid-token and leak its unredacted prefix.
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), true);

        let long_line = format!("{} user@example.com", "p".repeat(489));
        let out = anonymize_scan_line(&state, "sess-a", &long_line, 500);
        assert!(!out.contains("user@"), "partial/full email leaked: {out}");
    }

    #[test]
    fn anonymize_scan_line_truncates_after_anonymizing_respects_custom_cap() {
        // h_search_with_context accepts a caller-supplied `max_line_chars`
        // (up to 8000) instead of the fixed 500 h_search/h_lines_around use —
        // verify the cap is still honored post-anonymization.
        let state = AppState::new();
        state
            .mcp_anonymize
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert("sess-a".to_string(), false); // flag off: raw passes through unchanged

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
    fn ui_caller_is_never_anonymized_even_when_the_flag_says_yes() {
        // The user is looking at their own machine's logs in their own app.
        // The per-session flag exists to gate what leaves for an AGENT.
        let (ctx, _tmp) = test_ctx().with_session("s1", 1).mcp_anonymize("s1", true).build();
        assert!(!should_anonymize(&ctx, "s1"));
        let out = redact_line(&ctx, "s1", "contact user@example.com", 500);
        assert_eq!(out, "contact user@example.com");
    }

    #[test]
    fn agent_caller_fails_closed_for_an_unsignalled_session() {
        let (ctx, _tmp) = test_ctx().caller(Caller::Agent { client: "mcp".into() }).build();
        assert!(should_anonymize(&ctx, "never-seen"));
        let out = redact_line(&ctx, "never-seen", "contact user@example.com", 500);
        assert!(!out.contains("user@example.com"), "raw PII leaked: {out}");
    }

    #[test]
    fn agent_caller_gets_raw_text_when_the_session_explicitly_opted_out() {
        let (ctx, _tmp) = test_ctx()
            .caller(Caller::Agent { client: "mcp".into() })
            .mcp_anonymize("s1", false)
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
            .mcp_anonymize("s1", true)
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
