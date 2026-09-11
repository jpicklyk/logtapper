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

use serde::Serialize;
use ts_rs::TS;

use crate::anonymizer::config::AnonymizerConfig;
use crate::anonymizer::LogAnonymizer;
use crate::commands::bridge_access::McpOpenAllowlist;

use super::paths::AppPaths;
use super::policy::deny_agent_gate_mutation;
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
