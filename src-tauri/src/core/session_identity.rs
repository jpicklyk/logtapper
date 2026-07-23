//! Stable, deterministic session-identity derivation (design §Q5).
//!
//! Session ids were historically minted per load via `Uuid::new_v4`, so every
//! app restart invalidated MCP client handles ("Session not found" after every
//! restart) and made restore diagnostics impossible to correlate across runs.
//! This module derives ids deterministically from source identity + content, so
//! an unchanged on-disk file keeps its id across restarts, while replaced
//! content gets a fresh id — stale artifacts and stale MCP handles then simply
//! don't attach to different data (the desired behavior) instead of attaching at
//! the wrong line numbers.
//!
//! Ids are opaque strings everywhere (AppState `HashMap` keys, MCP URL path
//! segments, React `Map` keys); no consumer assumes a UUID shape. A single-char
//! kind prefix keeps the three id kinds disjoint and greppable:
//!   - `f-` file loads
//!   - `l-` `.lts` archive entries
//!   - `a-` ADB streams
//!
//! Ids are truncated to 16 hex chars (64 bits) — collision-safe for the
//! realistic session population; nothing downstream depends on id length.

use sha2::{Digest, Sha256};
use std::path::Path;

/// Leading hex characters of the sha256 digest kept in derived ids (64 bits).
const ID_HEX_LEN: usize = 16;

/// Bytes of the file prefix folded into a file id. Ties identity to *this*
/// content: a bugreport replaced at the same path gets a new id, so stale
/// artifacts / MCP handles do not silently attach to different data.
const FILE_PREFIX_BYTES: usize = 64 * 1024;

/// Canonicalize `path` (stripping the Windows `\\?\` extended-length prefix) via
/// the codebase's shared [`crate::simplified_path`], as a lossy `String`.
/// `simplified_path` falls back to the original path when canonicalization fails
/// (e.g. the file no longer exists) — determinism for a given input is preserved
/// either way.
fn canonical_path_string(path: &Path) -> String {
    crate::simplified_path(path).to_string_lossy().into_owned()
}

/// First `ID_HEX_LEN` hex chars of a digest.
fn truncated_hex(digest: &[u8]) -> String {
    hex::encode(digest)[..ID_HEX_LEN].to_string()
}

/// Match the existing ADB serial sanitization (`adb.rs`, `':' -> '-'`).
fn sanitize_serial(serial: &str) -> String {
    serial.replace(':', "-")
}

/// Read a file's length and up to `FILE_PREFIX_BYTES` of its leading bytes.
/// Degrades to `(0, empty)` on I/O error — still deterministic for that input.
fn read_len_and_prefix(path: &Path) -> (u64, Vec<u8>) {
    use std::io::Read;
    let file_len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let prefix = match std::fs::File::open(path) {
        Ok(mut f) => {
            let mut buf = vec![0u8; FILE_PREFIX_BYTES];
            let mut filled = 0usize;
            loop {
                match f.read(&mut buf[filled..]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        filled += n;
                        if filled >= FILE_PREFIX_BYTES {
                            break;
                        }
                    }
                }
            }
            buf.truncate(filled);
            buf
        }
        Err(_) => Vec::new(),
    };
    (file_len, prefix)
}

/// Derive a stable id for a log-file load.
///
/// Preimage: lowercased canonical path ∥ file length ∥ sha256(content prefix).
/// The path is lowercased because NTFS is case-insensitive (belt-and-braces on
/// top of `canonicalize`, which already normalizes case to the on-disk name on
/// Windows but is a no-op when it falls back). `file_len` is in the preimage
/// deliberately: an *appended* file (same first 64 KiB, larger length) changes
/// id too. Residual "same id ⇒ byte-identical prefix + length" means any stale
/// cache line under a reused id would be identical anyway.
pub fn derive_file_session_id(path: &Path, file_len: u64, content_prefix: &[u8]) -> String {
    let canonical = canonical_path_string(path).to_lowercase();
    let inner = Sha256::digest(content_prefix);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.update([0u8]); // domain separator between the variable-length path and fixed fields
    hasher.update(file_len.to_le_bytes());
    hasher.update(inner);
    format!("f-{}", truncated_hex(&hasher.finalize()))
}

/// Derive a file session id by reading length + content prefix from disk.
/// Pass the *original* user-facing path (for a `.zip` bugreport this is the
/// `.zip`, not the temp extraction) so the id is stable across restarts.
pub fn derive_file_session_id_from_disk(path: &Path) -> String {
    let (file_len, prefix) = read_len_and_prefix(path);
    derive_file_session_id(path, file_len, &prefix)
}

/// Derive a stable id for one `.lts` archive entry. Every entry in a `.lts`
/// shares one `file_path`, so the manifest `entry_index` disambiguates them; the
/// index is stable because `.lts` files are immutable after export.
pub fn derive_lts_session_id(lts_path: &Path, entry_index: usize) -> String {
    let canonical = canonical_path_string(lts_path);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.update([0u8]);
    hasher.update((entry_index as u64).to_le_bytes());
    format!("l-{}", truncated_hex(&hasher.finalize()))
}

/// Derive an id for an ADB stream. Streams are excluded from `.ltw` saves, so
/// cross-restart stability is moot; the `start_epoch_ms` suffix keeps a
/// stop/start cycle from aliasing the previous run's pipeline results.
pub fn derive_adb_session_id(serial: &str, start_epoch_ms: u128) -> String {
    format!("a-{}-{start_epoch_ms}", sanitize_serial(serial))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // ── File id: determinism ────────────────────────────────────────────────
    #[test]
    fn file_id_is_deterministic() {
        let p = Path::new("/nonexistent/device.log");
        let a = derive_file_session_id(p, 1234, b"hello world");
        let b = derive_file_session_id(p, 1234, b"hello world");
        assert_eq!(a, b, "same input must derive the same id");
        assert!(a.starts_with("f-"), "file ids carry the `f-` prefix");
        assert_eq!(a.len(), 2 + ID_HEX_LEN, "prefix + 16 hex chars");
    }

    // ── File id: path-case insensitivity ────────────────────────────────────
    // Non-existent paths force the canonicalize fallback, exercising the
    // explicit `.to_lowercase()`. (On Windows, canonicalize would also fold
    // case; this keeps the assertion portable to Linux CI.)
    #[test]
    fn file_id_is_path_case_insensitive() {
        let upper = derive_file_session_id(Path::new(r"C:\Logs\Device.LOG"), 10, b"x");
        let lower = derive_file_session_id(Path::new(r"c:\logs\device.log"), 10, b"x");
        assert_eq!(upper, lower, "NTFS case-insensitivity: differing case must not change the id");
    }

    // ── File id: content change flips id (replacement) ──────────────────────
    #[test]
    fn file_id_flips_on_content_change() {
        let p = Path::new("/nonexistent/device.log");
        let a = derive_file_session_id(p, 1234, b"original content");
        let b = derive_file_session_id(p, 1234, b"replaced content");
        assert_ne!(a, b, "replaced content at the same path must produce a new id");
    }

    // ── File id: length change flips id (append) ────────────────────────────
    #[test]
    fn file_id_flips_on_length_change() {
        let p = Path::new("/nonexistent/device.log");
        // Same first-64KiB prefix, different total length — models an append.
        let short = derive_file_session_id(p, 1000, b"shared prefix bytes");
        let long = derive_file_session_id(p, 2000, b"shared prefix bytes");
        assert_ne!(short, long, "an appended file (same prefix, larger len) must flip the id");
    }

    // ── File id from disk: real temp file round-trip ────────────────────────
    #[test]
    fn file_id_from_disk_is_stable_and_content_sensitive() {
        use std::io::Write;
        let mut tmp = tempfile::NamedTempFile::new().expect("tmpfile");
        writeln!(tmp, "line one\nline two").unwrap();
        tmp.flush().unwrap();

        let id1 = derive_file_session_id_from_disk(tmp.path());
        let id2 = derive_file_session_id_from_disk(tmp.path());
        assert_eq!(id1, id2, "unchanged file must derive the same id across calls");
        assert!(id1.starts_with("f-"));

        // Appending leaves the first-64KiB prefix identical but grows the length.
        writeln!(tmp, "line three").unwrap();
        tmp.flush().unwrap();
        let id3 = derive_file_session_id_from_disk(tmp.path());
        assert_ne!(id1, id3, "appending to the file must flip the id (length in preimage)");
    }

    // ── .lts index disambiguation ───────────────────────────────────────────
    #[test]
    fn lts_id_disambiguates_entries_by_index() {
        let p = Path::new("/nonexistent/export.lts");
        let e0 = derive_lts_session_id(p, 0);
        let e1 = derive_lts_session_id(p, 1);
        assert_ne!(e0, e1, "entries at the same path must differ by index");
        assert_eq!(e0, derive_lts_session_id(p, 0), "same (path, index) is deterministic");
        assert!(e0.starts_with("l-"), ".lts ids carry the `l-` prefix");
        assert_eq!(e0.len(), 2 + ID_HEX_LEN);
    }

    // ── ADB serial sanitization + epoch de-aliasing ─────────────────────────
    #[test]
    fn adb_id_sanitizes_serial_and_carries_prefix() {
        let id = derive_adb_session_id("192.168.1.5:5555", 1_700_000_000_000);
        assert!(id.starts_with("a-"), "ADB ids carry the `a-` prefix");
        assert!(!id.contains(':'), "colons in the serial must be sanitized to '-'");
        assert_eq!(id, "a-192.168.1.5-5555-1700000000000");
    }

    #[test]
    fn adb_id_is_deterministic_but_epoch_prevents_aliasing() {
        let a = derive_adb_session_id("emulator-5554", 100);
        let b = derive_adb_session_id("emulator-5554", 100);
        assert_eq!(a, b, "same serial + epoch is deterministic");
        let later = derive_adb_session_id("emulator-5554", 200);
        assert_ne!(a, later, "a later stop/start cycle must not alias the previous run's id");
    }

    // ── Kinds stay disjoint ─────────────────────────────────────────────────
    #[test]
    fn id_kinds_are_disjoint_by_prefix() {
        let f = derive_file_session_id(Path::new("/x/a"), 1, b"c");
        let l = derive_lts_session_id(Path::new("/x/a"), 0);
        let a = derive_adb_session_id("s", 1);
        assert_ne!(&f[..2], &l[..2]);
        assert_ne!(&f[..2], &a[..2]);
        assert_ne!(&l[..2], &a[..2]);
    }
}
