//! Access-control gate for the `logtapper_open_file` MCP bridge endpoint.
//!
//! The MCP bridge (`mcp_bridge.rs`) is an unauthenticated Axum server bound to
//! `127.0.0.1:40404`. The `open_file` route lets an MCP client read an
//! arbitrary path off disk — this module is the gate that route calls first:
//!
//! - **Config plumbing**: [`McpOpenAllowlist`], persisted to
//!   `{app_data_dir}/mcp_open_allowlist.json`, mirroring the anonymizer config
//!   pattern in `commands/anonymizer.rs` (config struct + `Mutex` field on
//!   `AppState` + `get_*`/`set_*` Tauri commands + startup load in
//!   `lib.rs::setup()`). Default-deny: an empty `allowed_dirs` list.
//! - **Path validation**: [`validate_open_path`], the security-critical
//!   function the `open_file` handler (`mcp_bridge::h_open_file`) calls before
//!   touching the filesystem on behalf of an MCP client. See its doc comment
//!   for the full validation order and rationale.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::{lock_or_err, AppState};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Directories an MCP client is permitted to open files from via the
/// `logtapper_open_file` endpoint. Persisted verbatim as the user entered
/// them (see [`validate_open_path`] for how entries are resolved/compared).
///
/// Default-deny: an empty `allowed_dirs` means no path is ever permitted,
/// aside from re-opening a session that is already open (see
/// `validate_open_path`'s auto-permit step).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOpenAllowlist {
    pub allowed_dirs: Vec<String>,
}

fn persist_mcp_open_allowlist(app: &AppHandle, allowlist: &McpOpenAllowlist) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(allowlist).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join("mcp_open_allowlist.json"), json)
        .map_err(|e| format!("Failed to persist MCP open allowlist: {e}"))
}

// ---------------------------------------------------------------------------
// get_mcp_open_allowlist
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_mcp_open_allowlist(state: State<'_, AppState>) -> Vec<String> {
    match lock_or_err(&state.mcp_open_allowlist, "mcp_open_allowlist") {
        Ok(cfg) => cfg.allowed_dirs.clone(),
        Err(_) => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// set_mcp_open_allowlist
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn set_mcp_open_allowlist(
    state: State<'_, AppState>,
    app: AppHandle,
    dirs: Vec<String>,
) -> Result<(), String> {
    let allowlist = McpOpenAllowlist { allowed_dirs: dirs };
    persist_mcp_open_allowlist(&app, &allowlist)?;
    let mut stored = lock_or_err(&state.mcp_open_allowlist, "mcp_open_allowlist")?;
    *stored = allowlist;
    Ok(())
}

// ---------------------------------------------------------------------------
// Path validation — the security core
// ---------------------------------------------------------------------------

/// Why a candidate path was refused for opening over the MCP bridge.
///
/// `NotAllowed` deliberately covers both "outside the permitted set" and
/// "could not be resolved" (nonexistent file, permission error, junction
/// loop) — collapsing these into one variant means an MCP client cannot use
/// the error to probe for the existence of files outside what it's allowed
/// to see. `InvalidPath` is reserved for malformed *input* (relative, UNC,
/// ADS) where there is no filesystem information to leak by being specific.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenAccessError {
    /// Outside every allowed directory, or unresolvable. Same variant for
    /// both cases by design — see type-level doc comment.
    NotAllowed,
    /// Malformed input rejected before any filesystem access was attempted.
    InvalidPath(String),
}

impl std::fmt::Display for OpenAccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenAccessError::NotAllowed => write!(f, "path is not allowed"),
            OpenAccessError::InvalidPath(msg) => write!(f, "invalid path: {msg}"),
        }
    }
}

impl std::error::Error for OpenAccessError {}

/// Strip the Windows `\\?\` extended-length/verbatim prefix that
/// `std::fs::canonicalize` adds, if present. Mirrors the logic in
/// `crate::simplified_path`, but returns a bare `PathBuf` rather than falling
/// back to the un-canonicalized input on failure — callers here always pass
/// an already-canonicalized path, so there is no failure case to fall back
/// from.
fn strip_verbatim_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(stripped) => PathBuf::from(stripped),
        None => p.to_path_buf(),
    }
}

/// Canonicalize `p`, strip the `\\?\` prefix, and lowercase the result for
/// case-insensitive comparison (NTFS is case-insensitive; same rationale as
/// `core::session_identity::canonical_path_string`, which this deliberately
/// does not reuse: that helper *falls back* to the original path string when
/// canonicalization fails, which is correct for its use — deterministic
/// session ids even for a file that no longer exists — but wrong here, where
/// a canonicalize failure must be distinguishable so callers can skip a
/// bad allowlist entry (or reject an unresolvable candidate) rather than
/// silently comparing against a non-canonical string.
///
/// Exported so the `open_file` endpoint and `close_stale_sessions`
/// (`commands/files.rs`) share this exact comparison form instead of
/// growing a third variant of the canonicalize-strip-lowercase logic.
pub fn canonical_compare_form(p: &Path) -> Option<String> {
    let canonical = std::fs::canonicalize(p).ok()?;
    let stripped = strip_verbatim_prefix(&canonical);
    Some(stripped.to_string_lossy().to_lowercase())
}

/// True iff every component of `dir_normalized` is a prefix of the
/// components of `candidate_normalized`, in order. Both strings must already
/// be normalized (canonicalized, prefix-stripped, lowercased) via
/// [`canonical_compare_form`] or the equivalent inline steps in
/// [`validate_open_path`].
///
/// Deliberately component-wise rather than a raw string prefix check: a
/// naive `candidate.starts_with(dir)` would let an allowlist entry
/// `C:\logs` match a sibling directory `C:\logs-evil` because the strings
/// share a prefix even though the paths do not nest.
fn components_prefix(dir_normalized: &str, candidate_normalized: &str) -> bool {
    let mut dir_components = Path::new(dir_normalized).components();
    let mut candidate_components = Path::new(candidate_normalized).components();
    loop {
        match dir_components.next() {
            None => return true,
            Some(dc) => match candidate_components.next() {
                Some(cc) if cc == dc => {}
                _ => return false,
            },
        }
    }
}

/// Validate `raw` for opening over the MCP bridge and return the
/// canonicalized path to open on success.
///
/// `allowed_dirs` are the configured allowlist entries, as raw strings
/// (mirrors [`McpOpenAllowlist::allowed_dirs`]). `open_session_canonical_paths`
/// are the canonical-lowercased paths (see [`canonical_compare_form`]) of
/// sessions that are already open — reopening one of those exposes nothing
/// new, so it is auto-permitted even outside the allowlist.
///
/// Validation order (each step is load-bearing — do not reorder):
///
/// 1. **Raw-form rejection** (pure string checks, no filesystem access):
///    reject non-absolute input; reject `\\`/`//`-prefixed paths (covers UNC
///    shares, `\\?\` verbatim paths, and `\\.\` device paths); reject NTFS
///    alternate data streams (a `:` at a byte index > 1 — index 1 is the
///    drive-letter colon in `C:\...`, which must NOT be rejected).
/// 2. **Canonicalize** `raw` via `std::fs::canonicalize`. Failure (file does
///    not exist, permission denied, junction loop, ...) maps to
///    `NotAllowed` — the SAME variant used for "outside every allowed dir",
///    so a client cannot distinguish "doesn't exist" from "not permitted" by
///    probing paths outside its allowed set. Canonicalize also resolves
///    symlinks/junctions/8.3 short names/case, so containment below is
///    checked against the *resolved* target — a symlink inside an allowed
///    directory that points outside it is rejected, not silently followed.
/// 3. **Normalize** the canonicalized result for comparison: strip the
///    `\\?\` prefix, then lowercase (Windows path comparison is
///    case-insensitive).
/// 4. **Auto-permit reopen**: if the normalized form matches an entry in
///    `open_session_canonical_paths`, return `Ok` immediately.
/// 5. **Containment**: canonicalize + normalize each configured allowed
///    directory the same way (an entry that fails to canonicalize — e.g. it
///    was deleted or renamed since being configured — is skipped, not
///    treated as an error) and check whether its path *components* are a
///    prefix of the candidate's components (never a raw string prefix — see
///    [`components_prefix`]). First match wins and returns `Ok` with the
///    canonicalized (not lowercased) `PathBuf` from step 2. No match →
///    `NotAllowed`.
pub fn validate_open_path(
    allowed_dirs: &[String],
    open_session_canonical_paths: &[String],
    raw: &str,
) -> Result<PathBuf, OpenAccessError> {
    // Step 1: raw-form rejection — pure string checks, before any filesystem access.
    if !Path::new(raw).is_absolute() {
        return Err(OpenAccessError::InvalidPath(
            "path must be absolute".to_string(),
        ));
    }
    // Reject by parsed prefix kind, not by string form: Windows accepts `/`
    // and `\` interchangeably, so `/\server\share` and `\/server/share` parse
    // as UNC even though neither starts with a literal `\\` or `//`. Only a
    // plain drive prefix (`C:\...`) is acceptable — UNC would make this
    // process issue outbound SMB, and verbatim/device forms bypass the
    // normalization the containment check depends on.
    match Path::new(raw).components().next() {
        Some(std::path::Component::Prefix(p))
            if matches!(p.kind(), std::path::Prefix::Disk(_)) => {}
        _ => {
            return Err(OpenAccessError::InvalidPath(
                "only local drive paths (C:\\...) are allowed; UNC (\\\\server\\share), verbatim (\\\\?\\...), and device (\\\\.\\...) paths are not"
                    .to_string(),
            ));
        }
    }
    if raw.match_indices(':').any(|(i, _)| i > 1) {
        return Err(OpenAccessError::InvalidPath(
            "alternate data stream paths are not allowed".to_string(),
        ));
    }

    // Step 2: canonicalize. Unresolvable → NotAllowed (indistinguishable from
    // "outside the allowlist" by design — see OpenAccessError doc comment).
    let canonical = std::fs::canonicalize(raw).map_err(|_| OpenAccessError::NotAllowed)?;

    // Step 3: normalize for comparison.
    let candidate_display = strip_verbatim_prefix(&canonical);
    let candidate_normalized = candidate_display.to_string_lossy().to_lowercase();

    // Step 4: auto-permit reopen of an already-open session.
    if open_session_canonical_paths
        .iter()
        .any(|p| p == &candidate_normalized)
    {
        return Ok(candidate_display);
    }

    // Step 5: containment within a configured allowed directory.
    for dir in allowed_dirs {
        let Some(dir_normalized) = canonical_compare_form(Path::new(dir)) else {
            // Allowlist entry doesn't exist / can't be resolved — skip it,
            // not an error (the rest of the allowlist may still match).
            continue;
        };
        if components_prefix(&dir_normalized, &candidate_normalized) {
            return Ok(candidate_display);
        }
    }

    Err(OpenAccessError::NotAllowed)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Write `content` to `dir/name` and return the file's full path as a
    /// `String`, for building raw path inputs to `validate_open_path`.
    fn write_file(dir: &Path, name: &str, content: &str) -> String {
        let path = dir.join(name);
        fs::write(&path, content).expect("write test file");
        path.to_string_lossy().into_owned()
    }

    // ── Step 1: raw-form rejection ──────────────────────────────────────────

    #[test]
    fn relative_path_is_rejected() {
        let result = validate_open_path(&[], &[], r"relative\path.log");
        assert_eq!(
            result,
            Err(OpenAccessError::InvalidPath("path must be absolute".to_string()))
        );
    }

    #[test]
    fn empty_path_is_rejected() {
        let result = validate_open_path(&[], &[], "");
        assert!(matches!(result, Err(OpenAccessError::InvalidPath(_))));
    }

    #[test]
    fn unc_share_is_rejected_as_invalid_path() {
        let result = validate_open_path(&[], &[], r"\\server\share\file.log");
        assert!(
            matches!(result, Err(OpenAccessError::InvalidPath(_))),
            "UNC share must be InvalidPath, got {result:?}"
        );
    }

    #[test]
    fn verbatim_prefix_is_rejected_as_invalid_path() {
        let result = validate_open_path(&[], &[], r"\\?\C:\x");
        assert!(
            matches!(result, Err(OpenAccessError::InvalidPath(_))),
            "\\\\?\\ verbatim path must be InvalidPath, got {result:?}"
        );
    }

    #[test]
    fn device_prefix_is_rejected_as_invalid_path() {
        let result = validate_open_path(&[], &[], r"\\.\C:\x");
        assert!(
            matches!(result, Err(OpenAccessError::InvalidPath(_))),
            "\\\\.\\ device path must be InvalidPath, got {result:?}"
        );
    }

    #[test]
    fn forward_slash_unc_is_rejected_as_invalid_path() {
        let result = validate_open_path(&[], &[], "//server/share");
        assert!(
            matches!(result, Err(OpenAccessError::InvalidPath(_))),
            "// UNC-style path must be InvalidPath, got {result:?}"
        );
    }

    #[test]
    fn mixed_separator_unc_is_rejected_as_invalid_path() {
        // Windows treats `/` and `\` interchangeably, so a leading `/\` or
        // `\/` still parses as UNC even though it matches neither the `\\` nor
        // the `//` literal. A string-prefix check would miss these and let
        // canonicalize issue outbound SMB; the component/prefix-kind check
        // must catch them. Both must be InvalidPath, not NotAllowed.
        for raw in [r"/\server\share\file.log", r"\/server/share/file.log"] {
            let result = validate_open_path(&[], &[], raw);
            assert!(
                matches!(result, Err(OpenAccessError::InvalidPath(_))),
                "mixed-separator UNC {raw:?} must be InvalidPath, got {result:?}"
            );
        }
    }

    #[test]
    fn alternate_data_stream_is_rejected() {
        let result = validate_open_path(&[], &[], r"C:\somewhere\file.log:hidden-stream");
        assert!(
            matches!(result, Err(OpenAccessError::InvalidPath(_))),
            "ADS path must be InvalidPath, got {result:?}"
        );
    }

    #[test]
    fn drive_colon_alone_is_not_rejected_as_invalid_path() {
        // A well-formed absolute path with only the drive-letter colon must
        // pass step 1's raw checks. It doesn't exist, so it should fail at
        // canonicalize (NotAllowed) rather than at the raw-form step
        // (InvalidPath) — proving the drive colon itself isn't flagged as an
        // ADS attempt.
        let tmp = tempfile::tempdir().expect("tempdir");
        let nonexistent = tmp.path().join("does-not-exist.log");
        let raw = nonexistent.to_string_lossy().into_owned();

        let result = validate_open_path(&[], &[], &raw);
        assert_eq!(
            result,
            Err(OpenAccessError::NotAllowed),
            "drive-colon-only path must clear raw-form checks and fail only at canonicalize"
        );
    }

    // ── Step 2/5: canonicalize + containment ────────────────────────────────

    #[test]
    fn traversal_escape_from_allowed_dir_is_rejected() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let allowed = tmp.path().join("allowed");
        let secret = tmp.path().join("secret");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&secret).unwrap();
        write_file(&secret, "secret.log", "top secret");

        // Raw path escapes `allowed` via `..` back out to the sibling `secret` dir.
        let raw = allowed.join("..").join("secret").join("secret.log");
        let raw_str = raw.to_string_lossy().into_owned();

        let allowed_dirs = vec![allowed.to_string_lossy().into_owned()];
        let result = validate_open_path(&allowed_dirs, &[], &raw_str);
        assert_eq!(
            result,
            Err(OpenAccessError::NotAllowed),
            "canonicalize must resolve the `..` and containment must then reject the escape"
        );
    }

    #[test]
    fn nonexistent_file_inside_allowed_dir_is_not_allowed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let allowed = tmp.path().join("allowed");
        fs::create_dir_all(&allowed).unwrap();

        let raw = allowed.join("nope.log").to_string_lossy().into_owned();
        let allowed_dirs = vec![allowed.to_string_lossy().into_owned()];

        let result = validate_open_path(&allowed_dirs, &[], &raw);
        assert_eq!(result, Err(OpenAccessError::NotAllowed));
    }

    #[test]
    fn file_outside_every_allowed_dir_is_not_allowed_same_variant_as_unresolvable() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let allowed = tmp.path().join("allowed");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let outside_file = write_file(&outside, "real.log", "data");

        let allowed_dirs = vec![allowed.to_string_lossy().into_owned()];

        let outside_result = validate_open_path(&allowed_dirs, &[], &outside_file);
        let unresolvable_result = validate_open_path(
            &allowed_dirs,
            &[],
            &allowed.join("also-nope.log").to_string_lossy(),
        );

        assert_eq!(outside_result, Err(OpenAccessError::NotAllowed));
        assert_eq!(unresolvable_result, Err(OpenAccessError::NotAllowed));
        assert_eq!(
            outside_result, unresolvable_result,
            "outside-allowlist and unresolvable must be the indistinguishable NotAllowed variant"
        );
    }

    #[test]
    fn string_prefix_trap_sibling_dir_is_rejected() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let logs = tmp.path().join("logs");
        let logs_evil = tmp.path().join("logs-evil");
        fs::create_dir_all(&logs).unwrap();
        fs::create_dir_all(&logs_evil).unwrap();
        let evil_file = write_file(&logs_evil, "trap.log", "gotcha");

        let allowed_dirs = vec![logs.to_string_lossy().into_owned()];
        let result = validate_open_path(&allowed_dirs, &[], &evil_file);
        assert_eq!(
            result,
            Err(OpenAccessError::NotAllowed),
            "`logs-evil` must not match allowlist entry `logs` via raw string prefix"
        );
    }

    #[test]
    fn case_insensitive_match_is_allowed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let allowed = tmp.path().join("allowed");
        fs::create_dir_all(&allowed).unwrap();
        let file = write_file(&allowed, "device.log", "data");

        // Uppercase the whole raw path (drive letter + directory names) —
        // Windows filesystem lookups are case-insensitive, so this still
        // resolves to the same file, and comparison must match too.
        let uppercased = file.to_uppercase();

        let allowed_dirs = vec![allowed.to_string_lossy().into_owned()];
        let result = validate_open_path(&allowed_dirs, &[], &uppercased);
        assert!(result.is_ok(), "case-differing path must still match: {result:?}");
    }

    #[test]
    fn empty_allowlist_and_no_open_sessions_denies_everything() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = write_file(tmp.path(), "device.log", "data");

        let result = validate_open_path(&[], &[], &file);
        assert_eq!(result, Err(OpenAccessError::NotAllowed));
    }

    #[test]
    fn auto_permit_reopen_bypasses_empty_allowlist() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = write_file(tmp.path(), "device.log", "data");

        let canonical_form = canonical_compare_form(Path::new(&file)).expect("canonicalize test file");
        let open_sessions = vec![canonical_form];

        let result = validate_open_path(&[], &open_sessions, &file);
        assert!(
            result.is_ok(),
            "reopening an already-open session must be permitted even with an empty allowlist: {result:?}"
        );
    }

    #[test]
    fn allowlist_entry_that_does_not_exist_on_disk_is_skipped_without_panicking() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing_allowed = tmp.path().join("this-dir-does-not-exist");
        let other = tmp.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let file = write_file(&other, "device.log", "data");

        let allowed_dirs = vec![missing_allowed.to_string_lossy().into_owned()];
        let result = validate_open_path(&allowed_dirs, &[], &file);
        assert_eq!(
            result,
            Err(OpenAccessError::NotAllowed),
            "a nonexistent allowlist entry must be skipped, not panic or error out"
        );
    }

    // ── Junction/symlink escape ──────────────────────────────────────────────
    //
    // Desirable coverage: an allowed directory containing a junction/symlink
    // that points *outside* the allowed tree must be rejected, because
    // containment is checked on the canonicalized (resolved) target, not the
    // symlink's own location. `std::os::windows::fs::symlink_dir` requires
    // either Administrator privileges or Windows Developer Mode enabled, and
    // `mklink /J` (junctions, which need neither) requires shelling out to
    // `cmd.exe` — neither is reliable in an arbitrary CI/test environment, so
    // this is `#[ignore]`d rather than flaking the suite.
    //
    // To run manually: enable Developer Mode (Settings > Privacy & Security >
    // For developers > Developer Mode) or run as Administrator, then:
    //   cargo test --manifest-path src-tauri/Cargo.toml junction_escape_is_rejected -- --ignored
    #[test]
    #[ignore = "requires Developer Mode or Administrator privileges to create a symlink/junction"]
    fn junction_escape_is_rejected() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let allowed = tmp.path().join("allowed");
        let secret = tmp.path().join("secret");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&secret).unwrap();
        let secret_file = write_file(&secret, "secret.log", "top secret");

        let link = allowed.join("escape");
        #[cfg(target_os = "windows")]
        {
            std::os::windows::fs::symlink_dir(&secret, &link).expect(
                "creating a directory symlink requires Developer Mode or Administrator \
                 privileges — see test doc comment",
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(&secret, &link).expect("creating symlink");
        }

        let raw = link.join("secret.log").to_string_lossy().into_owned();
        let allowed_dirs = vec![allowed.to_string_lossy().into_owned()];
        let result = validate_open_path(&allowed_dirs, &[], &raw);

        assert_eq!(
            result,
            Err(OpenAccessError::NotAllowed),
            "a symlink inside an allowed dir that resolves outside it must be rejected: {secret_file}"
        );
    }

    // ── canonical_compare_form ───────────────────────────────────────────────

    #[test]
    fn canonical_compare_form_returns_none_for_nonexistent_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("nope");
        assert_eq!(canonical_compare_form(&missing), None);
    }

    #[test]
    fn canonical_compare_form_lowercases_and_strips_verbatim_prefix() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let form = canonical_compare_form(tmp.path()).expect("canonicalize tempdir");
        assert!(!form.starts_with(r"\\?\"), "verbatim prefix must be stripped: {form}");
        assert_eq!(form, form.to_lowercase(), "form must already be lowercased");
    }

    // ── components_prefix ────────────────────────────────────────────────────

    #[test]
    fn components_prefix_rejects_string_prefix_that_is_not_a_path_prefix() {
        assert!(!components_prefix(r"c:\logs", r"c:\logs-evil\file.log"));
    }

    #[test]
    fn components_prefix_accepts_true_nesting() {
        assert!(components_prefix(r"c:\logs", r"c:\logs\sub\file.log"));
        assert!(components_prefix(r"c:\logs", r"c:\logs"));
    }
}
