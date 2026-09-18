//! Anonymizer configuration, PII-mapping access, and the MCP open-file
//! allowlist — the settings an agent must never be able to widen on its own.
//!
//! Every mutation here runs [`policy::deny_agent_gate_mutation`] first: an
//! agent that could loosen its own anonymizer config or open-file allowlist
//! could un-redact itself or read anything on disk, which defeats the whole
//! point of those gates. Reads are split by sensitivity instead of a blanket
//! rule — see each function's doc comment for why it is or isn't gated.
//!
//! `mcp_status` is deliberately **not** implemented here: `commands::session::
//! get_mcp_status` (owned by WP-6/sessions) only locks two `AppState` fields
//! and formats a struct — there is no orchestration or caller-identity
//! decision to centralize, so moving it would be a pure relocation with no
//! behavioral benefit. It stays where it is; nothing in this module reaches
//! for `AppState::mcp_bridge_port` or `mcp_last_activity`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::anonymizer::config::{AnonymizerConfig, AnonymizerMode};
use crate::anonymizer::LogAnonymizer;
use crate::commands::bridge_access::McpOpenAllowlist;

use super::paths::AppPaths;
use super::policy::{self, deny_agent_gate_mutation, Pathway};
use super::{lock_svc, Caller, ServiceCtx, ServiceError};

// ---------------------------------------------------------------------------
// test_anonymizer wire types (moved from `commands::anonymizer`, unchanged)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PiiReplacement {
    pub token: String,
    pub original: String,
    pub category: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AnonymizerTestResult {
    pub anonymized: String,
    pub replacements: Vec<PiiReplacement>,
}

// ---------------------------------------------------------------------------
// Anonymizer config
// ---------------------------------------------------------------------------

/// Read the current anonymizer configuration. Readable by both callers — an
/// agent seeing which detectors/patterns are configured is not a privacy
/// leak; only *changing* them is (see [`set_anonymizer_config`]).
pub fn anonymizer_config(ctx: &ServiceCtx) -> Result<AnonymizerConfig, ServiceError> {
    let config = lock_svc(&ctx.state().anonymizer_config, "anonymizer_config")?;
    Ok(config.clone())
}

/// Persist `config` to `{app_data_dir}/anonymizer_config.json`.
///
/// Takes `&dyn AppPaths` rather than an `AppHandle`, mirroring
/// `persist_mcp_open_allowlist` below — this is exercisable without a live
/// Tauri app, which matters because this is one of the gates an agent may not
/// widen (see [`deny_agent_gate_mutation`]).
fn persist_anonymizer_config(paths: &dyn AppPaths, config: &AnonymizerConfig) -> Result<(), ServiceError> {
    let data_dir = paths.app_data_dir()?;
    std::fs::create_dir_all(&data_dir).map_err(|e| ServiceError::Internal(e.to_string()))?;
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| ServiceError::Internal(e.to_string()))?;
    std::fs::write(data_dir.join("anonymizer_config.json"), json)
        .map_err(|e| ServiceError::Internal(format!("Failed to persist anonymizer config: {e}")))
}

/// Replace the anonymizer configuration.
///
/// **`Agent` -> `Forbidden`**: an agent that could widen its own redaction
/// rules could effectively un-redact itself. Journals `settings.anonymizer`.
pub fn set_anonymizer_config(ctx: &ServiceCtx, config: AnonymizerConfig) -> Result<(), ServiceError> {
    deny_agent_gate_mutation(ctx, "the anonymizer configuration")?;

    persist_anonymizer_config(ctx.paths(), &config)?;
    {
        let mut stored = lock_svc(&ctx.state().anonymizer_config, "anonymizer_config")?;
        *stored = config;
    }

    ctx.journal("settings.anonymizer", None, "updated the anonymizer configuration");
    Ok(())
}

/// Preview what the current anonymizer configuration would redact in `text`.
///
/// Open to both callers: it never mutates persisted config and never reveals
/// anything beyond what the caller just handed it in `text` — the
/// `LogAnonymizer` it builds is a fresh, throwaway instance, not the
/// persistent per-session one `redact_line` uses. Not journaled: it's a read.
pub fn test_anonymizer(ctx: &ServiceCtx, text: String) -> Result<AnonymizerTestResult, ServiceError> {
    let config = {
        let c = lock_svc(&ctx.state().anonymizer_config, "anonymizer_config")?;
        c.clone()
    };

    let anon = LogAnonymizer::from_config(&config);
    let (anonymized, spans) = anon.anonymize(&text);

    let mut replacements = Vec::with_capacity(spans.len());
    for span in spans {
        let token = anonymized[span.start..span.end].to_string();
        let original = anon.mappings.reveal(&token).unwrap_or_default();
        // Parse category from token: "<EMAIL-1>" -> "EMAIL"
        let category = token
            .trim_start_matches('<')
            .split('-')
            .next()
            .unwrap_or("PII")
            .to_string();
        replacements.push(PiiReplacement {
            token,
            original,
            category,
            start: span.start,
            end: span.end,
        });
    }

    Ok(AnonymizerTestResult { anonymized, replacements })
}

/// Redact frontend-assembled text that is about to leave the tool — copy to
/// clipboard, the bookmark Markdown export — under the
/// [`Pathway::External`] decision.
///
/// Unlike [`test_anonymizer`] this uses the *session's* cached
/// `LogAnonymizer` (`mcp_anonymizers`, via [`policy::anonymize_session_text`])
/// so the tokens in a pasted snippet match what the viewer and an `.lts`
/// export of the same session show. Returns `text` unchanged when the mode
/// says this pathway is raw (`None`), and under `All` the cache the caller
/// assembled from is already anonymized so the same tokens come back — one
/// code path for the frontend, whatever the mode.
///
/// **`Agent` → `Forbidden`.** An agent has no clipboard; every text it can
/// obtain is already redacted on the read path, and this exists only so text
/// the desktop assembled locally can leave redacted. Not journaled: a read.
pub fn anonymize_text(ctx: &ServiceCtx, session_id: &str, text: String) -> Result<String, ServiceError> {
    if let Caller::Agent { .. } = ctx.caller() {
        return Err(ServiceError::not_allowed(
            "agents may not use the clipboard redaction command",
        ));
    }
    if !policy::should_anonymize_for(ctx, Pathway::External) {
        return Ok(text);
    }
    Ok(policy::anonymize_session_text(ctx.state(), session_id, &text))
}

/// The token -> original-value map accumulated for `session_id`.
///
/// **`Agent` -> `Forbidden`**: this is the reverse of anonymization — an
/// agent that could read it would recover every value the bridge's own
/// redaction is supposed to hide from it. Not journaled: reads never are.
pub fn pii_mappings(ctx: &ServiceCtx, session_id: &str) -> Result<HashMap<String, String>, ServiceError> {
    if let Caller::Agent { .. } = ctx.caller() {
        return Err(ServiceError::not_allowed(
            "agents may not read PII mappings",
        ));
    }
    let mappings = lock_svc(&ctx.state().pii_mappings, "pii_mappings")?;
    Ok(mappings.get(session_id).cloned().unwrap_or_default())
}

// ---------------------------------------------------------------------------
// MCP open-file allowlist
// ---------------------------------------------------------------------------

/// Read the configured MCP open-file allowlist.
///
/// Readable by both callers — an agent may see what it is allowed to open;
/// only widening the list is forbidden (see [`set_open_allowlist`]).
pub fn open_allowlist(ctx: &ServiceCtx) -> Result<McpOpenAllowlist, ServiceError> {
    let cfg = lock_svc(&ctx.state().mcp_open_allowlist, "mcp_open_allowlist")?;
    Ok(cfg.clone())
}

/// Persist `allowlist` to `{app_data_dir}/mcp_open_allowlist.json`.
///
/// Moved here from `commands::bridge_access` verbatim (same `&dyn AppPaths`
/// signature) — `bridge_access` keeps `validate_open_path` /
/// `canonical_compare_form`, the security-critical path-matching logic, and
/// its own test suite untouched.
fn persist_mcp_open_allowlist(paths: &dyn AppPaths, allowlist: &McpOpenAllowlist) -> Result<(), ServiceError> {
    let data_dir = paths.app_data_dir()?;
    std::fs::create_dir_all(&data_dir).map_err(|e| ServiceError::Internal(e.to_string()))?;
    let json = serde_json::to_string_pretty(allowlist)
        .map_err(|e| ServiceError::Internal(e.to_string()))?;
    std::fs::write(data_dir.join("mcp_open_allowlist.json"), json)
        .map_err(|e| ServiceError::Internal(format!("Failed to persist MCP open allowlist: {e}")))
}

/// Replace the MCP open-file allowlist.
///
/// **`Agent` -> `Forbidden`**: an agent that could widen its own allowlist
/// could read anything on disk through `open_file`. Journals
/// `settings.allowlist`.
pub fn set_open_allowlist(ctx: &ServiceCtx, allowlist: McpOpenAllowlist) -> Result<(), ServiceError> {
    deny_agent_gate_mutation(ctx, "the open-file allowlist")?;

    persist_mcp_open_allowlist(ctx.paths(), &allowlist)?;
    {
        let mut stored = lock_svc(&ctx.state().mcp_open_allowlist, "mcp_open_allowlist")?;
        *stored = allowlist;
    }

    ctx.journal("settings.allowlist", None, "updated the open-file allowlist");
    Ok(())
}

// ---------------------------------------------------------------------------
// Agent raw-access opt-out
// ---------------------------------------------------------------------------

/// File name (under `app_data_dir`) holding the persisted agent raw-access
/// opt-out. Read at startup by `lib.rs::setup`, written by
/// [`set_agent_raw_access`].
pub const AGENT_ACCESS_FILE: &str = "mcp_agent_access.json";

/// On-disk shape of [`AGENT_ACCESS_FILE`]. A struct rather than a bare bool so
/// a future agent-visibility setting can join it without a migration. Only the
/// opt-out itself is persisted here — the anonymizer mode lives in
/// `anonymizer_config.json`, and [`McpAgentAccess`] is the *computed* view
/// that puts the two together for the wire.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentAccessFile {
    /// `true` = agents receive raw, un-anonymized log text. Default `false`.
    pub agent_raw_access: bool,
}

/// What an agent (and the desktop's presence pill) is told about its own
/// visibility — `GET /mcp/settings/agent_access` and part of `McpStatus`.
///
/// `effective_agent_raw` is computed **here**, once, so the presence pill, the
/// anonymizer card, Settings and the MCP `agent_access` action can never
/// disagree about whether agents currently read raw text: they do when the
/// mode is `None` *or* the raw-access opt-out is on — see
/// `policy::should_anonymize_for`.
#[derive(Debug, Default, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct McpAgentAccess {
    /// The persisted opt-out (Settings → General → MCP Integration).
    pub agent_raw_access: bool,
    /// The anonymizer master switch (`AnonymizerConfig::mode`).
    pub anonymizer_mode: AnonymizerMode,
    /// `anonymizer_mode == None || agent_raw_access` — whether agents are
    /// reading raw log text right now, whichever setting caused it.
    pub effective_agent_raw: bool,
}

/// Whether agents may read raw (un-anonymized) log text — the persisted
/// opt-out alone. Use [`agent_access`] for the effective answer.
///
/// Readable by both callers: an agent learning *that* it is being redacted
/// reveals nothing the redaction itself doesn't already make obvious, and the
/// UI status pill shows the same value. Only *changing* it is gated.
pub fn agent_raw_access(ctx: &ServiceCtx) -> Result<bool, ServiceError> {
    let flag = lock_svc(&ctx.state().agent_raw_access, "agent_raw_access")?;
    Ok(*flag)
}

/// The computed [`McpAgentAccess`]: opt-out, mode, and their combination.
/// Readable by both callers for the same reason as [`agent_raw_access`].
pub fn agent_access(ctx: &ServiceCtx) -> Result<McpAgentAccess, ServiceError> {
    let agent_raw_access = agent_raw_access(ctx)?;
    let anonymizer_mode = policy::anonymizer_mode(ctx.state());
    Ok(McpAgentAccess {
        agent_raw_access,
        anonymizer_mode,
        effective_agent_raw: anonymizer_mode == AnonymizerMode::None || agent_raw_access,
    })
}

/// Persist the agent raw-access opt-out to `{app_data_dir}/mcp_agent_access.json`.
fn persist_agent_raw_access(paths: &dyn AppPaths, enabled: bool) -> Result<(), ServiceError> {
    let data_dir = paths.app_data_dir()?;
    std::fs::create_dir_all(&data_dir).map_err(|e| ServiceError::Internal(e.to_string()))?;
    let json = serde_json::to_string_pretty(&AgentAccessFile { agent_raw_access: enabled })
        .map_err(|e| ServiceError::Internal(e.to_string()))?;
    std::fs::write(data_dir.join(AGENT_ACCESS_FILE), json)
        .map_err(|e| ServiceError::Internal(format!("Failed to persist MCP agent access: {e}")))
}

/// Enable or disable raw (un-anonymized) agent reads.
///
/// **`Agent` -> `Forbidden`**: this is the gate that decides whether an agent
/// sees PII at all — an agent able to flip it could un-redact itself, which is
/// the entire reason [`deny_agent_gate_mutation`] exists. There is deliberately
/// **no bridge route** for this: the only way to change it is the checkbox in
/// Settings → General → MCP Integration. Journals `settings.agent_raw_access`.
pub fn set_agent_raw_access(ctx: &ServiceCtx, enabled: bool) -> Result<(), ServiceError> {
    deny_agent_gate_mutation(ctx, "agent raw log access")?;

    persist_agent_raw_access(ctx.paths(), enabled)?;
    {
        let mut stored = lock_svc(&ctx.state().agent_raw_access, "agent_raw_access")?;
        *stored = enabled;
    }

    ctx.journal(
        "settings.agent_raw_access",
        None,
        if enabled {
            "allowed agents to read raw (un-anonymized) log text"
        } else {
            "restored agent log anonymization"
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;

    // ── anonymizer_config / set_anonymizer_config ───────────────────────────

    #[test]
    fn anonymizer_config_reads_the_default_when_unset() {
        let (ctx, _tmp) = test_ctx().build();
        let cfg = anonymizer_config(&ctx).unwrap();
        assert_eq!(cfg.detectors.len(), AnonymizerConfig::with_defaults().detectors.len());
    }

    #[test]
    fn ui_can_set_anonymizer_config_and_it_persists_and_journals() {
        let (ctx, _tmp) = test_ctx().build();
        let mut cfg = AnonymizerConfig::with_defaults();
        cfg.detectors.clear();

        set_anonymizer_config(&ctx, cfg.clone()).expect("Ui must be allowed to set config");

        assert_eq!(anonymizer_config(&ctx).unwrap().detectors.len(), 0);

        let data_dir = ctx.paths().app_data_dir().unwrap();
        let on_disk = std::fs::read_to_string(data_dir.join("anonymizer_config.json"))
            .expect("config must be persisted to disk");
        let reloaded: AnonymizerConfig = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(reloaded.detectors.len(), 0);

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "settings.anonymizer");
    }

    #[test]
    fn agent_cannot_set_anonymizer_config() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = set_anonymizer_config(&ctx, AnonymizerConfig::with_defaults())
            .expect_err("agents must not be able to widen their own redaction rules");
        assert!(matches!(err, ServiceError::Forbidden { .. }));
        assert_eq!(err.code(), "NOT_ALLOWED");
        // Nothing was persisted or journaled.
        assert!(ctx.state().activity.list(None, None).is_empty());
    }

    #[test]
    fn agent_can_read_anonymizer_config() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        assert!(anonymizer_config(&ctx).is_ok());
    }

    // ── test_anonymizer ──────────────────────────────────────────────────────

    #[test]
    fn test_anonymizer_redacts_and_reveals_replacements() {
        let (ctx, _tmp) = test_ctx().build();
        let result = test_anonymizer(&ctx, "contact user@example.com now".to_string()).unwrap();

        assert!(!result.anonymized.contains("user@example.com"));
        assert_eq!(result.replacements.len(), 1);
        assert_eq!(result.replacements[0].original, "user@example.com");
        assert_eq!(result.replacements[0].category, "EMAIL");
    }

    #[test]
    fn agent_can_call_test_anonymizer() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        assert!(test_anonymizer(&ctx, "no pii here".to_string()).is_ok());
    }

    // ── pii_mappings ─────────────────────────────────────────────────────────

    #[test]
    fn ui_can_read_pii_mappings() {
        let (ctx, _tmp) = test_ctx().build();
        ctx.state()
            .pii_mappings
            .lock()
            .unwrap()
            .entry("s1".to_string())
            .or_default()
            .insert("<EMAIL-1>".to_string(), "user@example.com".to_string());

        let mappings = pii_mappings(&ctx, "s1").unwrap();
        assert_eq!(mappings.get("<EMAIL-1>").unwrap(), "user@example.com");
    }

    #[test]
    fn pii_mappings_for_unknown_session_is_empty_not_an_error() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(pii_mappings(&ctx, "no-such-session").unwrap().is_empty());
    }

    #[test]
    fn agent_cannot_read_pii_mappings() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        ctx.state()
            .pii_mappings
            .lock()
            .unwrap()
            .entry("s1".to_string())
            .or_default()
            .insert("<EMAIL-1>".to_string(), "user@example.com".to_string());

        let err = pii_mappings(&ctx, "s1")
            .expect_err("agents must never receive the token -> original map");
        assert!(matches!(err, ServiceError::Forbidden { .. }));
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    // ── open_allowlist / set_open_allowlist ────────────────────────────────

    #[test]
    fn open_allowlist_reads_the_default_when_unset() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(open_allowlist(&ctx).unwrap().allowed_dirs.is_empty());
    }

    #[test]
    fn agent_can_read_the_allowlist() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").allowlist("C:\\logs").build();
        let list = open_allowlist(&ctx).unwrap();
        assert_eq!(list.allowed_dirs, vec!["C:\\logs".to_string()]);
    }

    #[test]
    fn ui_can_set_the_allowlist_and_it_persists_and_journals() {
        let (ctx, _tmp) = test_ctx().build();
        let allowlist = McpOpenAllowlist {
            allowed_dirs: vec!["C:\\logs".to_string()],
            allow_all: false,
        };

        set_open_allowlist(&ctx, allowlist.clone()).expect("Ui must be allowed to set the allowlist");

        assert_eq!(open_allowlist(&ctx).unwrap().allowed_dirs, allowlist.allowed_dirs);

        let data_dir = ctx.paths().app_data_dir().unwrap();
        let on_disk = std::fs::read_to_string(data_dir.join("mcp_open_allowlist.json"))
            .expect("allowlist must be persisted to disk");
        let reloaded: McpOpenAllowlist = serde_json::from_str(&on_disk).unwrap();
        assert_eq!(reloaded.allowed_dirs, allowlist.allowed_dirs);

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "settings.allowlist");
    }

    // ── agent_raw_access / set_agent_raw_access ────────────────────────────

    #[test]
    fn agent_raw_access_defaults_to_false() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(!agent_raw_access(&ctx).unwrap(), "agents must be anonymized by default");
    }

    #[test]
    fn ui_can_set_agent_raw_access_and_it_persists_and_journals() {
        let (ctx, _tmp) = test_ctx().build();

        set_agent_raw_access(&ctx, true).expect("Ui must be allowed to set the opt-out");
        assert!(agent_raw_access(&ctx).unwrap());

        let data_dir = ctx.paths().app_data_dir().unwrap();
        let on_disk = std::fs::read_to_string(data_dir.join(AGENT_ACCESS_FILE))
            .expect("the opt-out must be persisted to disk");
        let reloaded: AgentAccessFile = serde_json::from_str(&on_disk).unwrap();
        assert!(reloaded.agent_raw_access);
        assert!(on_disk.contains("agentRawAccess"), "persisted key must be camelCase: {on_disk}");
        assert!(
            !on_disk.contains("anonymizerMode") && !on_disk.contains("effectiveAgentRaw"),
            "computed fields must not be persisted: {on_disk}"
        );

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "settings.agent_raw_access");
    }

    #[test]
    fn ui_can_turn_agent_raw_access_back_off() {
        let (ctx, _tmp) = test_ctx().agent_raw_access(true).build();
        set_agent_raw_access(&ctx, false).expect("Ui may restore anonymization");
        assert!(!agent_raw_access(&ctx).unwrap());

        let data_dir = ctx.paths().app_data_dir().unwrap();
        let reloaded: AgentAccessFile = serde_json::from_str(
            &std::fs::read_to_string(data_dir.join(AGENT_ACCESS_FILE)).unwrap(),
        )
        .unwrap();
        assert!(!reloaded.agent_raw_access);
    }

    #[test]
    fn agent_cannot_set_agent_raw_access() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = set_agent_raw_access(&ctx, true)
            .expect_err("agents must not be able to un-redact themselves");
        assert!(matches!(err, ServiceError::Forbidden { .. }));
        assert_eq!(err.code(), "NOT_ALLOWED");
        // Nothing flipped, nothing persisted, nothing journaled.
        assert!(!agent_raw_access(&ctx).unwrap());
        let data_dir = ctx.paths().app_data_dir().unwrap();
        assert!(!data_dir.join(AGENT_ACCESS_FILE).exists());
        assert!(ctx.state().activity.list(None, None).is_empty());
    }

    #[test]
    fn agent_can_read_agent_raw_access() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        assert!(!agent_raw_access(&ctx).unwrap());
    }

    #[test]
    fn a_missing_or_corrupt_settings_file_parses_as_anonymized() {
        // `#[serde(default)]` on the struct: an empty object, or one written
        // by a future version with extra fields, must still mean "redact".
        let empty: AgentAccessFile = serde_json::from_str("{}").unwrap();
        assert!(!empty.agent_raw_access);
        assert!(!AgentAccessFile::default().agent_raw_access);
    }

    // ── agent_access (the computed view) ───────────────────────────────────

    #[test]
    fn agent_access_reports_effective_raw_from_either_setting() {
        let (ctx, _t1) = test_ctx().build();
        let a = agent_access(&ctx).unwrap();
        assert_eq!(a.anonymizer_mode, AnonymizerMode::External);
        assert!(!a.agent_raw_access);
        assert!(!a.effective_agent_raw);

        let (ctx, _t2) = test_ctx().agent_raw_access(true).build();
        assert!(agent_access(&ctx).unwrap().effective_agent_raw, "the opt-out alone makes agents raw");

        let (ctx, _t3) = test_ctx().anonymizer_mode(AnonymizerMode::None).build();
        let a = agent_access(&ctx).unwrap();
        assert!(!a.agent_raw_access);
        assert!(a.effective_agent_raw, "mode None alone makes agents raw");

        let (ctx, _t4) = test_ctx().anonymizer_mode(AnonymizerMode::All).build();
        assert!(!agent_access(&ctx).unwrap().effective_agent_raw);
    }

    #[test]
    fn agent_can_read_agent_access_and_the_wire_keys_are_camel_case() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let json = serde_json::to_value(agent_access(&ctx).unwrap()).unwrap();
        assert_eq!(json["agentRawAccess"], false);
        assert_eq!(json["anonymizerMode"], "external");
        assert_eq!(json["effectiveAgentRaw"], false);
    }

    // ── the anonymizer mode is a gate an agent cannot flip ─────────────────

    #[test]
    fn agent_cannot_change_the_anonymizer_mode() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let mut cfg = AnonymizerConfig::with_defaults();
        cfg.mode = AnonymizerMode::None;
        let err = set_anonymizer_config(&ctx, cfg)
            .expect_err("an agent turning the anonymizer off would un-redact itself");
        assert!(matches!(err, ServiceError::Forbidden { .. }));
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert_eq!(anonymizer_config(&ctx).unwrap().mode, AnonymizerMode::External);
        assert!(ctx.state().activity.list(None, None).is_empty());
    }

    #[test]
    fn ui_can_change_the_anonymizer_mode_and_it_persists() {
        let (ctx, _tmp) = test_ctx().build();
        let mut cfg = AnonymizerConfig::with_defaults();
        cfg.mode = AnonymizerMode::All;
        set_anonymizer_config(&ctx, cfg).unwrap();
        assert_eq!(anonymizer_config(&ctx).unwrap().mode, AnonymizerMode::All);

        let data_dir = ctx.paths().app_data_dir().unwrap();
        let on_disk = std::fs::read_to_string(data_dir.join("anonymizer_config.json")).unwrap();
        assert!(on_disk.contains("\"mode\": \"all\""), "{on_disk}");
    }

    // ── anonymize_text ──────────────────────────────────────────────────────

    #[test]
    fn anonymize_text_redacts_under_external_and_all_with_the_sessions_tokens() {
        for mode in [AnonymizerMode::External, AnonymizerMode::All] {
            let (ctx, _tmp) = test_ctx().anonymizer_mode(mode).build();
            // The viewer/export path has already numbered this address for
            // the session; the clipboard copy must reuse that token.
            let seen = policy::anonymize_session_text(ctx.state(), "s1", "first user@example.com");
            let token = seen.split_whitespace().last().unwrap().to_string();

            let out = anonymize_text(&ctx, "s1", "copied: user@example.com".to_string()).unwrap();
            assert!(!out.contains("user@example.com"), "{mode:?}: {out}");
            assert_eq!(out, format!("copied: {token}"), "{mode:?}: tokens must match the session");
        }
    }

    #[test]
    fn anonymize_text_returns_the_input_unchanged_under_none() {
        let (ctx, _tmp) = test_ctx().anonymizer_mode(AnonymizerMode::None).build();
        let text = "copied: user@example.com".to_string();
        assert_eq!(anonymize_text(&ctx, "s1", text.clone()).unwrap(), text);
    }

    #[test]
    fn anonymize_text_is_forbidden_for_an_agent() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = anonymize_text(&ctx, "s1", "user@example.com".to_string())
            .expect_err("an agent has no clipboard");
        assert!(matches!(err, ServiceError::Forbidden { .. }));
        assert_eq!(err.code(), "NOT_ALLOWED");
    }

    #[test]
    fn agent_cannot_widen_the_allowlist() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = set_open_allowlist(
            &ctx,
            McpOpenAllowlist { allowed_dirs: vec!["C:\\".to_string()], allow_all: true },
        )
        .expect_err("agents must not be able to widen their own open-file gate");
        assert!(matches!(err, ServiceError::Forbidden { .. }));
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert!(ctx.state().activity.list(None, None).is_empty());
    }
}
