//! Bundle metadata pin.
//!
//! Windows installer/MSI properties (Manufacturer, copyright) and store-facing
//! description text come from `tauri.conf.json`'s `bundle` block. Pins the
//! publisher string specifically — a drift here silently changes what the
//! Windows Installer shows as "Publisher" for every future release.
//!
//! Run with:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --test bundle_metadata
//! ```

use std::fs;
use std::path::Path;

use serde_json::Value;

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn load_config() -> Value {
    let path = manifest_dir().join("tauri.conf.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
}

#[test]
fn publisher_is_jeff_picklyk() {
    let config = load_config();
    let publisher = config
        .pointer("/bundle/publisher")
        .and_then(Value::as_str)
        .expect("bundle.publisher must be set — it becomes the Windows Installer Manufacturer property");
    assert_eq!(publisher, "Jeff Picklyk");
}

#[test]
fn bundle_declares_store_facing_metadata() {
    let config = load_config();
    for field in ["copyright", "category", "shortDescription", "longDescription", "homepage"] {
        let pointer = format!("/bundle/{field}");
        let value = config.pointer(&pointer).and_then(Value::as_str);
        assert!(
            value.is_some_and(|s| !s.trim().is_empty()),
            "bundle.{field} must be a non-empty string"
        );
    }
}
