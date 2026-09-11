//! User theme storage — JSON files at `{app_data_dir}/themes/<slug>.json`.
//!
//! Mirrors the frontend's `UserTheme` shape (`src-solid/theme/userTheme.ts`):
//! `{ name, base, tokens }`, where `base` picks one of the four built-in
//! themes to start from and `tokens` holds partial CSS custom-property
//! overrides. `list`/`read` are open to both callers (seeing what themes
//! exist, or the contents of one, is not a privacy-sensitive read); `write`/
//! `delete` are **Ui-only** via [`policy::deny_agent_gate_mutation`] — the
//! same mechanism that protects the anonymizer config, the open-file
//! allowlist, and the agent raw-access setting. A user theme is UI
//! configuration a human picks for their own machine, not something an agent
//! should be able to plant or overwrite.
//!
//! Validation here is a structural safety net, not a duplicate of the
//! frontend's `KNOWN_TOKENS` allowlist (`src-solid/theme/userTheme.ts`): a
//! token name must start with `--` and otherwise be `[a-z0-9-]+`, and a
//! value must look like a colour (`#rgb`/`#rrggbb`/`#rrggbbaa`,
//! `rgb()`/`rgba()`) or a length (`\d+(\.\d+)?(px|rem|em)`) — never a
//! keyword, `url()`, or anything else CSS would otherwise accept, since the
//! value is later written straight into an inline `style` attribute.
//!
//! Writes are atomic: written to `<slug>.json.tmp` then renamed over the
//! final path, so a crash mid-write can never leave a half-written theme file
//! for [`list`]/[`read`] to trip over.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::policy::deny_agent_gate_mutation;
use super::{ServiceCtx, ServiceError};

/// Maximum number of token overrides a single theme may declare.
pub const MAX_TOKENS: usize = 200;
/// Maximum serialized size of a single theme's JSON, in bytes.
pub const MAX_THEME_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Which built-in theme a user theme starts from — see
/// `src-solid/styles/tokens.css`'s four `[data-theme=...]` attribute blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeBase {
    Dark,
    Light,
    DarkHc,
    LightHc,
}

/// A user theme as stored and returned: a display name, the built-in base it
/// overrides, and a set of CSS custom-property overrides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserTheme {
    pub name: String,
    pub base: ThemeBase,
    #[serde(default)]
    #[ts(type = "Record<string, string>")]
    pub tokens: BTreeMap<String, String>,
}

/// One `GET /mcp/themes` entry — enough to list and pick a theme without
/// reading every file's full token map.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSummary {
    pub slug: String,
    pub name: String,
    pub base: ThemeBase,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

static SLUG_RE: OnceLock<Regex> = OnceLock::new();
fn slug_re() -> &'static Regex {
    SLUG_RE.get_or_init(|| Regex::new(r"^[a-z0-9-]{1,64}$").expect("valid slug regex"))
}

static TOKEN_NAME_RE: OnceLock<Regex> = OnceLock::new();
fn token_name_re() -> &'static Regex {
    TOKEN_NAME_RE.get_or_init(|| Regex::new(r"^--[a-z0-9-]+$").expect("valid token-name regex"))
}

static COLOR_RE: OnceLock<Regex> = OnceLock::new();
fn color_re() -> &'static Regex {
    COLOR_RE.get_or_init(|| {
        Regex::new(r"(?i)^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\([^()]*\))$")
            .expect("valid colour regex")
    })
}

static LENGTH_RE: OnceLock<Regex> = OnceLock::new();
fn length_re() -> &'static Regex {
    LENGTH_RE.get_or_init(|| {
        Regex::new(r"^\d+(\.\d+)?(px|rem|em)$").expect("valid length regex")
    })
}

/// `[a-z0-9-]{1,64}` — a single plain path segment, safe to join under
/// `{app_data_dir}/themes/` with no traversal risk.
fn validate_slug(slug: &str) -> Result<(), ServiceError> {
    if slug_re().is_match(slug) {
        Ok(())
    } else {
        Err(ServiceError::invalid_arg(format!(
            "invalid theme slug '{slug}' — must match [a-z0-9-]{{1,64}}"
        )))
    }
}

/// Structural validation mirroring the frontend's rules (see the module doc):
/// non-empty name, a token-count cap, a serialized-size cap, and every token
/// name/value shaped like a real CSS custom property / colour / length.
fn validate_theme(theme: &UserTheme) -> Result<(), ServiceError> {
    if theme.name.trim().is_empty() {
        return Err(ServiceError::invalid_arg("theme name must not be empty"));
    }
    if theme.tokens.len() > MAX_TOKENS {
        return Err(ServiceError::invalid_arg(format!(
            "theme has too many tokens ({} > {MAX_TOKENS} max)",
            theme.tokens.len()
        )));
    }
    let size = serde_json::to_vec(theme).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > MAX_THEME_BYTES {
        return Err(ServiceError::invalid_arg(format!(
            "theme exceeds the {MAX_THEME_BYTES}-byte size cap ({size} bytes)"
        )));
    }
    for (key, value) in &theme.tokens {
        if !token_name_re().is_match(key) {
            return Err(ServiceError::invalid_arg(format!(
                "invalid token name '{key}' — must start with '--' and match [a-z0-9-]+"
            )));
        }
        if !color_re().is_match(value) && !length_re().is_match(value) {
            return Err(ServiceError::invalid_arg(format!(
                "invalid value for token '{key}': '{value}' is not a colour or length"
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn themes_dir(ctx: &ServiceCtx) -> Result<PathBuf, ServiceError> {
    Ok(ctx.paths().app_data_dir()?.join("themes"))
}

fn theme_path(ctx: &ServiceCtx, slug: &str) -> Result<PathBuf, ServiceError> {
    validate_slug(slug)?;
    Ok(themes_dir(ctx)?.join(format!("{slug}.json")))
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/// List every stored user theme. Open to both callers. A missing themes
/// directory is an empty list, not an error; an unparsable or
/// invalid-slug-named file is skipped rather than failing the whole listing —
/// one corrupt theme must not hide every other one.
pub fn list(ctx: &ServiceCtx) -> Result<Vec<ThemeSummary>, ServiceError> {
    let dir = themes_dir(ctx)?;
    let mut out = Vec::new();

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => {
            return Err(ServiceError::Internal(format!(
                "failed to read themes directory: {e}"
            )));
        }
    };

    for entry in entries {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(slug) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !slug_re().is_match(slug) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(theme) = serde_json::from_str::<UserTheme>(&text) else { continue };
        out.push(ThemeSummary {
            slug: slug.to_string(),
            name: theme.name,
            base: theme.base,
        });
    }

    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(out)
}

/// Read one stored theme by slug. Open to both callers.
/// `ServiceError::NotFound` when the slug names no file.
pub fn read(ctx: &ServiceCtx, slug: &str) -> Result<UserTheme, ServiceError> {
    let path = theme_path(ctx, slug)?;
    let text = std::fs::read_to_string(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ServiceError::NotFound(format!("theme '{slug}' not found"))
        } else {
            ServiceError::Internal(format!("failed to read theme '{slug}': {e}"))
        }
    })?;
    serde_json::from_str(&text)
        .map_err(|e| ServiceError::Internal(format!("corrupt theme file '{slug}': {e}")))
}

/// Create or replace a stored theme. **`Agent` -> `Forbidden`**: an agent
/// that could plant or overwrite a user theme could quietly point a color
/// token somewhere misleading (or simply vandalize UI configuration) with no
/// human in the loop. Validates `slug` and `theme` before touching disk, so a
/// rejected write leaves any existing file untouched. Journals `theme.write`
/// and emits `theme-changed { slug }`.
pub fn write(ctx: &ServiceCtx, slug: &str, theme: UserTheme) -> Result<(), ServiceError> {
    deny_agent_gate_mutation(ctx, "user themes")?;
    validate_slug(slug)?;
    validate_theme(&theme)?;

    let dir = themes_dir(ctx)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| ServiceError::Internal(format!("failed to create themes directory: {e}")))?;

    let json = serde_json::to_string_pretty(&theme)
        .map_err(|e| ServiceError::Internal(e.to_string()))?;
    let final_path = dir.join(format!("{slug}.json"));
    let tmp_path = dir.join(format!("{slug}.json.tmp"));
    std::fs::write(&tmp_path, &json)
        .map_err(|e| ServiceError::Internal(format!("failed to write theme '{slug}': {e}")))?;
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        ServiceError::Internal(format!("failed to save theme '{slug}': {e}"))
    })?;

    ctx.journal("theme.write", None, format!("saved theme '{slug}'"));
    ctx.events()
        .emit_json("theme-changed", serde_json::json!({ "slug": slug }));
    Ok(())
}

/// Delete a stored theme by slug. **`Agent` -> `Forbidden`**, same rationale
/// as [`write`]. `ServiceError::NotFound` when the slug names no file — a
/// rejected delete (either reason) leaves the file untouched. Journals
/// `theme.delete` and emits `theme-changed { slug }`.
pub fn delete(ctx: &ServiceCtx, slug: &str) -> Result<(), ServiceError> {
    deny_agent_gate_mutation(ctx, "user themes")?;
    let path = theme_path(ctx, slug)?;
    if !path.exists() {
        return Err(ServiceError::NotFound(format!("theme '{slug}' not found")));
    }
    std::fs::remove_file(&path)
        .map_err(|e| ServiceError::Internal(format!("failed to delete theme '{slug}': {e}")))?;

    ctx.journal("theme.delete", None, format!("deleted theme '{slug}'"));
    ctx.events()
        .emit_json("theme-changed", serde_json::json!({ "slug": slug }));
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;
    use crate::services::ServiceError;

    fn sample(name: &str) -> UserTheme {
        let mut tokens = BTreeMap::new();
        tokens.insert("--level-error".to_string(), "#ff0000".to_string());
        tokens.insert("--ui-gap".to_string(), "8px".to_string());
        UserTheme {
            name: name.to_string(),
            base: ThemeBase::Dark,
            tokens,
        }
    }

    // ── serialization ────────────────────────────────────────────────────

    #[test]
    fn theme_base_serializes_kebab_case() {
        assert_eq!(serde_json::to_value(ThemeBase::Dark).unwrap(), "dark");
        assert_eq!(serde_json::to_value(ThemeBase::Light).unwrap(), "light");
        assert_eq!(serde_json::to_value(ThemeBase::DarkHc).unwrap(), "dark-hc");
        assert_eq!(serde_json::to_value(ThemeBase::LightHc).unwrap(), "light-hc");
    }

    #[test]
    fn user_theme_serializes_camel_case() {
        let v = serde_json::to_value(sample("My Theme")).unwrap();
        assert_eq!(v["name"], "My Theme");
        assert_eq!(v["base"], "dark");
        assert_eq!(v["tokens"]["--level-error"], "#ff0000");
    }

    #[test]
    fn tokens_default_to_empty_when_absent() {
        let theme: UserTheme =
            serde_json::from_value(serde_json::json!({ "name": "Bare", "base": "light" })).unwrap();
        assert!(theme.tokens.is_empty());
    }

    // ── list / read / write round trip ──────────────────────────────────

    #[test]
    fn list_is_empty_when_no_themes_dir_exists() {
        let (ctx, _tmp) = test_ctx().build();
        assert_eq!(list(&ctx).unwrap(), vec![]);
    }

    #[test]
    fn read_unknown_slug_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = read(&ctx, "nosuch").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn write_then_read_round_trips() {
        let (ctx, _tmp) = test_ctx().build();
        write(&ctx, "midnight", sample("Midnight")).unwrap();

        let read_back = read(&ctx, "midnight").unwrap();
        assert_eq!(read_back, sample("Midnight"));
    }

    #[test]
    fn write_then_list_includes_the_summary() {
        let (ctx, _tmp) = test_ctx().build();
        write(&ctx, "midnight", sample("Midnight")).unwrap();
        write(&ctx, "daybreak", sample("Daybreak")).unwrap();

        let summaries = list(&ctx).unwrap();
        assert_eq!(summaries.len(), 2);
        // Sorted by slug.
        assert_eq!(summaries[0].slug, "daybreak");
        assert_eq!(summaries[0].name, "Daybreak");
        assert_eq!(summaries[0].base, ThemeBase::Dark);
        assert_eq!(summaries[1].slug, "midnight");
    }

    #[test]
    fn write_then_delete_removes_the_file() {
        let (ctx, _tmp) = test_ctx().build();
        write(&ctx, "midnight", sample("Midnight")).unwrap();
        assert!(read(&ctx, "midnight").is_ok());

        delete(&ctx, "midnight").unwrap();
        let err = read(&ctx, "midnight").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        assert!(list(&ctx).unwrap().is_empty());
    }

    #[test]
    fn delete_unknown_slug_is_not_found() {
        let (ctx, _tmp) = test_ctx().build();
        let err = delete(&ctx, "nosuch").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn a_later_write_replaces_the_earlier_one() {
        let (ctx, _tmp) = test_ctx().build();
        write(&ctx, "midnight", sample("Midnight v1")).unwrap();
        write(&ctx, "midnight", sample("Midnight v2")).unwrap();

        assert_eq!(read(&ctx, "midnight").unwrap().name, "Midnight v2");
        assert_eq!(list(&ctx).unwrap().len(), 1);
    }

    #[test]
    fn write_leaves_no_tmp_file_behind() {
        let (ctx, tmp) = test_ctx().build();
        write(&ctx, "midnight", sample("Midnight")).unwrap();

        let dir = tmp.path().join("themes");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["midnight.json".to_string()]);
    }

    // ── journal + events ─────────────────────────────────────────────────

    #[test]
    fn write_journals_and_emits_theme_changed() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        write(&ctx, "midnight", sample("Midnight")).unwrap();

        let entries = ctx.state().activity.list(None, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].action, "theme.write");

        let emitted = sink.only_event("theme-changed");
        assert_eq!(emitted, serde_json::json!({ "slug": "midnight" }));
    }

    #[test]
    fn delete_journals_and_emits_theme_changed() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        write(&ctx, "midnight", sample("Midnight")).unwrap();
        sink.clear();

        delete(&ctx, "midnight").unwrap();

        let entries = ctx.state().activity.list(None, None);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].action, "theme.delete");

        let emitted = sink.only_event("theme-changed");
        assert_eq!(emitted, serde_json::json!({ "slug": "midnight" }));
    }

    // ── validation ───────────────────────────────────────────────────────

    #[test]
    fn write_rejects_an_invalid_slug() {
        let (ctx, _tmp) = test_ctx().build();
        for bad in ["Has-Caps", "has spaces", "has/slash", "", &"x".repeat(65)] {
            let err = write(&ctx, bad, sample("X")).unwrap_err();
            assert!(matches!(err, ServiceError::InvalidArg { .. }), "{bad}: {err:?}");
        }
    }

    #[test]
    fn write_rejects_an_empty_name() {
        let (ctx, _tmp) = test_ctx().build();
        let mut theme = sample("   ");
        theme.name = "   ".to_string();
        let err = write(&ctx, "midnight", theme).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn write_rejects_too_many_tokens() {
        let (ctx, _tmp) = test_ctx().build();
        let mut theme = sample("Big");
        theme.tokens.clear();
        for i in 0..(MAX_TOKENS + 1) {
            theme.tokens.insert(format!("--tok-{i}"), "1px".to_string());
        }
        let err = write(&ctx, "midnight", theme).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn write_rejects_an_oversized_theme() {
        let (ctx, _tmp) = test_ctx().build();
        let mut theme = sample("Big");
        theme.tokens.clear();
        // A handful of enormous but structurally-valid-looking names to blow
        // past the byte cap without touching the token-count cap.
        for i in 0..10 {
            theme.tokens.insert(format!("--tok-{i}"), "1".repeat(MAX_THEME_BYTES) + "px");
        }
        let err = write(&ctx, "midnight", theme).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn write_rejects_a_bad_token_name() {
        let (ctx, _tmp) = test_ctx().build();
        let mut theme = sample("X");
        theme.tokens.clear();
        theme.tokens.insert("level-error".to_string(), "#fff".to_string()); // missing --
        let err = write(&ctx, "midnight", theme).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");

        let mut theme2 = sample("X");
        theme2.tokens.clear();
        theme2.tokens.insert("--Level_Error".to_string(), "#fff".to_string()); // uppercase/underscore
        let err2 = write(&ctx, "midnight2", theme2).unwrap_err();
        assert_eq!(err2.code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn write_rejects_a_bad_token_value() {
        let (ctx, _tmp) = test_ctx().build();
        for bad_value in ["bold", "url(evil.css)", "javascript:alert(1)", "10%", "red"] {
            let mut theme = sample("X");
            theme.tokens.clear();
            theme.tokens.insert("--accent".to_string(), bad_value.to_string());
            let err = write(&ctx, "midnight", theme).unwrap_err();
            assert_eq!(err.code(), "INVALID_ARGUMENT", "expected '{bad_value}' to be rejected");
        }
    }

    #[test]
    fn write_accepts_every_documented_value_shape() {
        let (ctx, _tmp) = test_ctx().build();
        let good_values = [
            "#fff",
            "#ffffff",
            "#ffffffaa",
            "rgb(1, 2, 3)",
            "rgba(1, 2, 3, 0.5)",
            "12px",
            "1.5rem",
            "10em",
        ];
        for (i, value) in good_values.iter().enumerate() {
            let mut theme = sample("X");
            theme.tokens.clear();
            theme.tokens.insert("--accent".to_string(), value.to_string());
            write(&ctx, &format!("slug-{i}"), theme).unwrap_or_else(|e| {
                panic!("expected '{value}' to be accepted, got {e:?}")
            });
        }
    }

    #[test]
    fn a_rejected_write_leaves_an_existing_file_untouched() {
        let (ctx, _tmp) = test_ctx().build();
        write(&ctx, "midnight", sample("Midnight")).unwrap();

        let mut bad = sample("Broken");
        bad.tokens.insert("bad-token".to_string(), "x".to_string());
        assert!(write(&ctx, "midnight", bad).is_err());

        assert_eq!(read(&ctx, "midnight").unwrap().name, "Midnight");
    }

    // ── agent gate ───────────────────────────────────────────────────────

    #[test]
    fn agent_cannot_write_a_theme() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        let err = write(&ctx, "midnight", sample("Midnight"))
            .expect_err("agents must not be able to plant or overwrite a user theme");
        assert!(matches!(err, ServiceError::Forbidden { .. }));
        assert_eq!(err.code(), "NOT_ALLOWED");
        assert!(list(&ctx).unwrap().is_empty(), "nothing must be persisted");
        assert!(ctx.state().activity.list(None, None).is_empty());
    }

    #[test]
    fn agent_cannot_delete_a_theme() {
        let (ui_ctx, _tmp) = test_ctx().build();
        write(&ui_ctx, "midnight", sample("Midnight")).unwrap();
        let agent_ctx = ui_ctx.with_caller(crate::services::Caller::agent("claude-code"));

        let err = delete(&agent_ctx, "midnight")
            .expect_err("agents must not be able to delete a user theme");
        assert!(matches!(err, ServiceError::Forbidden { .. }));
        assert_eq!(err.code(), "NOT_ALLOWED");
        // Nothing removed.
        assert!(read(&ui_ctx, "midnight").is_ok());
    }

    #[test]
    fn agent_can_list_and_read_themes() {
        let (ui_ctx, _tmp) = test_ctx().build();
        write(&ui_ctx, "midnight", sample("Midnight")).unwrap();
        let agent_ctx = ui_ctx.with_caller(crate::services::Caller::agent("claude-code"));

        assert_eq!(list(&agent_ctx).unwrap().len(), 1);
        assert_eq!(read(&agent_ctx, "midnight").unwrap().name, "Midnight");
    }
}
