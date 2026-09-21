//! Installer-hook config pin.
//!
//! An in-app update on Windows is the updater plugin downloading the NSIS
//! installer and exiting the app so it can run. Any `logtapper-mcp.exe` still
//! alive at that moment — a crash orphan, or the sidecar of a build older than
//! 0.13.1 whose exit path never killed it — blocks the installer with a modal
//! "Error opening file for writing" and leaves the install half applied
//! (live finding, 2026-09-21). The app kills its own sidecar on that path now
//! (`on_app_exit` via `on_before_exit`, mechanism pinned in
//! `commands::mcp` tests); this file pins the installer-side half, which is
//! what protects installs *over* an older or crashed build:
//!
//! - `tauri.conf.json` wires `bundle.windows.nsis.installerHooks`,
//! - the file it points at exists,
//! - it defines the pre-install (and pre-uninstall) hook, and
//! - that hook terminates the sidecar by image name.
//!
//! Run with:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --test nsis_hooks
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

const SIDECAR_IMAGE: &str = "logtapper-mcp.exe";

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn load_config() -> Value {
    let path = manifest_dir().join("tauri.conf.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

/// The hooks file `tauri.conf.json` points at, resolved the way the bundler
/// resolves it (relative to the config's directory).
fn hooks_path() -> PathBuf {
    let config = load_config();
    let rel = config
        .pointer("/bundle/windows/nsis/installerHooks")
        .and_then(Value::as_str)
        .expect("bundle.windows.nsis.installerHooks must be set — without it the NSIS installer cannot overwrite a running logtapper-mcp.exe");
    manifest_dir().join(rel)
}

/// The body of one `!macro NAME … !macroend` block, or `None` if absent.
fn macro_body<'a>(source: &'a str, name: &str) -> Option<&'a str> {
    let start = source.find(&format!("!macro {name}"))?;
    let after = &source[start..];
    let end = after.find("!macroend")?;
    Some(&after[..end])
}

#[test]
fn installer_hooks_file_exists() {
    let path = hooks_path();
    assert!(path.is_file(), "installerHooks points at {}, which does not exist", path.display());
}

#[test]
fn pre_install_hook_terminates_the_sidecar() {
    let source = fs::read_to_string(hooks_path()).expect("read hooks file");
    let body = macro_body(&source, "NSIS_HOOK_PREINSTALL")
        .expect("hooks file must define NSIS_HOOK_PREINSTALL — it runs before any file is extracted");
    assert!(
        body.contains("taskkill") && body.contains(SIDECAR_IMAGE),
        "NSIS_HOOK_PREINSTALL must `taskkill` {SIDECAR_IMAGE} before extraction; got:\n{body}"
    );
    assert!(
        body.contains("/F"),
        "the kill must be forced (/F): a sidecar mid-request will not exit on a polite WM_CLOSE"
    );
}

#[test]
fn pre_uninstall_hook_terminates_the_sidecar() {
    let source = fs::read_to_string(hooks_path()).expect("read hooks file");
    let body = macro_body(&source, "NSIS_HOOK_PREUNINSTALL")
        .expect("hooks file must define NSIS_HOOK_PREUNINSTALL so an uninstall over a crash orphan can remove the exe");
    assert!(body.contains("taskkill") && body.contains(SIDECAR_IMAGE), "got:\n{body}");
}

/// `--config` overlays are JSON-merged over `tauri.conf.json`, and a merge
/// patch can null a key out. The overlays used by CI and the bench harness only
/// touch `build` and `bundle.externalBin`; none may mention `installerHooks`,
/// or the hook could silently vanish from the shipped installer.
#[test]
fn overlays_do_not_drop_the_hook() {
    let root = manifest_dir().parent().expect("repo root");
    let mut overlays = vec![manifest_dir().join("tauri.ci.conf.json")];
    if let Ok(entries) = fs::read_dir(root.join("scripts/bench")) {
        overlays.extend(entries.flatten().map(|e| e.path()).filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".conf.json"))
        }));
    }
    for path in overlays {
        let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let value: Value = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
        assert!(
            value.pointer("/bundle/windows/nsis/installerHooks").is_none(),
            "{} overrides bundle.windows.nsis.installerHooks; the shipped installer must keep the sidecar-kill hook",
            path.display()
        );
    }
}
