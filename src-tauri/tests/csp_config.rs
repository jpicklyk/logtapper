//! Content-Security-Policy config pin.
//!
//! Parses `tauri.conf.json` (the config source of truth, not the overlays —
//! `tauri.solid.conf.json` and `scripts/bench/*.bench.conf.json` only override
//! `build`, so `app.security` always comes from this file; see the
//! `overlays_do_not_override_security` test below) and asserts both the
//! production `csp` and the dev-only `devCsp` carry the required directives
//! and never regress to a dangerous wildcard or `'unsafe-eval'`.
//!
//! Run with:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --test csp_config
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::Value;

/// Directives every policy (prod and dev) must declare, with the exact
/// source list expected (order-independent — sources are split and matched
/// as a set so `"'self' data:"` and `"data: 'self'"` are equivalent).
const REQUIRED_DIRECTIVES: &[(&str, &[&str])] = &[
    ("default-src", &["'self'"]),
    ("script-src", &["'self'"]),
    ("style-src", &["'self'", "'unsafe-inline'"]),
    ("img-src", &["'self'", "data:", "asset:", "http://asset.localhost"]),
    ("font-src", &["'self'", "data:"]),
    ("connect-src", &["'self'", "ipc:", "http://ipc.localhost"]),
    ("object-src", &["'none'"]),
    ("base-uri", &["'self'"]),
    ("frame-ancestors", &["'none'"]),
];

/// Extra sources `devCsp`'s `connect-src` must carry on top of the production
/// set, for the Vite dev servers' HMR websockets (React on 1420, Solid on 1421).
const DEV_CONNECT_EXTRA: &[&str] = &[
    "ws://localhost:1420",
    "ws://localhost:1421",
    "http://localhost:1420",
    "http://localhost:1421",
];

/// Tokens that must never appear anywhere in either policy string, regardless
/// of directive. A wildcard or `'unsafe-eval'` defeats the point of a CSP.
const FORBIDDEN_TOKENS: &[&str] = &["'unsafe-eval'", "*"];

fn load_config() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

/// A `Csp` value in tauri's schema is either a single string or an object
/// mapping directive -> sources (string or array). Normalize either shape
/// into a directive -> sorted-source-set map for assertion.
fn directive_map(csp: &Value) -> BTreeMap<String, Vec<String>> {
    match csp {
        Value::Object(map) => map
            .iter()
            .map(|(directive, sources)| {
                let list = match sources {
                    Value::String(s) => s.split_whitespace().map(str::to_string).collect(),
                    Value::Array(items) => items
                        .iter()
                        .map(|v| v.as_str().expect("csp source must be a string").to_string())
                        .collect(),
                    other => panic!("unexpected csp directive value shape: {other:?}"),
                };
                (directive.clone(), list)
            })
            .collect(),
        Value::String(s) => {
            // Single "directive a b; directive2 c" string form.
            let mut out = BTreeMap::new();
            for clause in s.split(';') {
                let clause = clause.trim();
                if clause.is_empty() {
                    continue;
                }
                let mut parts = clause.split_whitespace();
                let directive = parts.next().expect("empty csp clause").to_string();
                out.insert(directive, parts.map(str::to_string).collect());
            }
            out
        }
        other => panic!("csp must be a string or object, got {other:?}"),
    }
}

fn assert_required_directives(policy_name: &str, map: &BTreeMap<String, Vec<String>>, extra_connect: &[&str]) {
    for (directive, required_sources) in REQUIRED_DIRECTIVES {
        let sources = map
            .get(*directive)
            .unwrap_or_else(|| panic!("{policy_name}: missing required directive `{directive}`"));

        for required in *required_sources {
            assert!(
                sources.iter().any(|s| s == required),
                "{policy_name}: directive `{directive}` is missing required source `{required}` (got {sources:?})"
            );
        }

        if *directive == "connect-src" {
            for extra in extra_connect {
                assert!(
                    sources.iter().any(|s| s == extra),
                    "{policy_name}: connect-src is missing `{extra}` (got {sources:?})"
                );
            }
        }
    }
}

fn assert_no_forbidden_tokens(policy_name: &str, map: &BTreeMap<String, Vec<String>>) {
    for (directive, sources) in map {
        for source in sources {
            for forbidden in FORBIDDEN_TOKENS {
                assert!(
                    source != forbidden,
                    "{policy_name}: directive `{directive}` contains forbidden source `{forbidden}`"
                );
            }
        }
    }
}

#[test]
fn production_csp_has_required_directives_and_no_forbidden_sources() {
    let config = load_config();
    let csp = &config["app"]["security"]["csp"];
    assert!(!csp.is_null(), "app.security.csp must not be null");

    let map = directive_map(csp);
    assert_required_directives("csp", &map, &[]);
    assert_no_forbidden_tokens("csp", &map);

    // style-src is the ONE justified 'unsafe-inline': CodeMirror's style-mod
    // injects <style> at runtime with no nonce wired in, and the Solid app's
    // theme controller sets custom properties via `element.style.setProperty()`
    // on <html> (also governed by style-src, not just <style> elements) for
    // colors only known at runtime — neither can be pinned by a build-time hash.
    // script-src stays 'self' with zero exceptions: the former inline
    // FOUC-prevention bootstrap was moved to public/theme-bootstrap.js (and
    // src-solid/public/theme-bootstrap.js) precisely so no script-src
    // exception is needed — see src-tauri/src/CLAUDE.md.
    assert!(
        !map["script-src"].iter().any(|s| s == "'unsafe-inline'"),
        "csp: script-src must not need 'unsafe-inline' — the bootstrap script is external"
    );
}

#[test]
fn dev_csp_has_required_directives_plus_vite_hmr_and_no_forbidden_sources() {
    let config = load_config();
    let dev_csp = &config["app"]["security"]["devCsp"];
    assert!(!dev_csp.is_null(), "app.security.devCsp must not be null");

    let map = directive_map(dev_csp);
    assert_required_directives("devCsp", &map, DEV_CONNECT_EXTRA);
    assert_no_forbidden_tokens("devCsp", &map);

    // Same reasoning as prod: no script-src exception needed even in dev,
    // since the theme bootstrap is an external, same-origin <script src>.
    assert!(
        !map["script-src"].iter().any(|s| s == "'unsafe-inline'"),
        "devCsp: script-src must not need 'unsafe-inline' — the bootstrap script is external"
    );
}

/// `tauri.solid.conf.json` and the bench configs must only override `build` —
/// if either ever grows an `app` key, it would silently replace (not merge
/// with) `app.security` and drop the whole CSP. This pins the assumption the
/// dev/prod CSP tests above rely on: there is exactly one `app.security` to
/// keep in sync.
#[test]
fn overlays_do_not_override_security() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let overlays = [
        manifest_dir.join("tauri.solid.conf.json"),
        manifest_dir.join("../scripts/bench/react.bench.conf.json"),
        manifest_dir.join("../scripts/bench/solid.bench.conf.json"),
    ];

    for overlay_path in overlays {
        let raw = fs::read_to_string(&overlay_path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", overlay_path.display()));
        let value: Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", overlay_path.display()));
        assert!(
            value.get("app").is_none(),
            "{} must not declare `app` (it would override, not merge with, \
             the base config's app.security and silently drop the CSP)",
            overlay_path.display()
        );
    }
}
