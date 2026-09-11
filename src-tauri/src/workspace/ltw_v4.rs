//! `.ltw` format version 4 — multi-session workspace with file references.
//!
//! Unlike v1 (single-file workspace) and `.lts` (embedded log data), this format
//! stores workspace state with **references** to log files on disk. No raw log data
//! is embedded, making files small (KB) and fast to save/load.
//!
//! ZIP layout:
//! ```text
//! manifest.json                        — workspace name, session list, timestamp
//! analyses.json                        — workspace-level analyses (all sessions)
//! sessions/{idx}/bookmarks.json        — per-session bookmarks
//! sessions/{idx}/analyses.json         — legacy per-session analyses; current
//!                                         writers always emit `[]` here (analyses
//!                                         moved to the top-level `analyses.json`).
//!                                         Kept so pre-migration readers relying on
//!                                         a hard `?` on this path can still open
//!                                         the workspace; read for migration only.
//! sessions/{idx}/pipeline-meta.json    — per-session processor chain + disabled
//! pipeline-chain.json                  — workspace-level pipeline chain order
//! editor-tabs.json                     — editor tab content + modes (optional)
//! layout.json                          — split tree, panel dimensions (optional)
//! ```

use std::fs::File;
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;

use crate::core::analysis::AnalysisArtifact;
use crate::core::bookmark::Bookmark;
use crate::workspace::{now_ms, zip_read_json, zip_write_json, SessionMeta};
use ts_rs::TS;

pub const LTW_V4_FORMAT_VERSION: u32 = 4;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtwManifest {
    pub format_version: u32,
    pub workspace_name: String,
    /// Stable workspace identifier (Q3). Additive and optional:
    /// `#[serde(default)]` means files written before this field existed parse
    /// as `None` — no format-version bump. Q3's trust gate matches this against
    /// the workspace entry's id; a `None` here marks a *legacy* file, which the
    /// gate trusts only if its session paths still intersect the open tabs.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub saved_at: i64,
    pub sessions: Vec<LtwManifestSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LtwManifestSession {
    /// Absolute path to the log file on disk.
    pub file_path: String,
    /// Display name (filename portion).
    pub source_name: String,
    /// Source type: Logcat, Bugreport, Dumpstate, Kernel, Unknown.
    pub source_type: String,
    /// The label a caller explicitly supplied at open to replace content
    /// detection, or `None` when the type above was detected.
    ///
    /// Only an explicit override is persisted. `source_type` records what the
    /// session ended up as and is informational; replaying *it* on restore
    /// would freeze detection, so a later detector fix could never reach an
    /// already-saved workspace. Defaults on read, so `.ltw` files written
    /// before this field existed still load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_type_override: Option<String>,
    /// The session id this entry's file resolved to when the workspace was
    /// saved (T8). Stamped from the live session at save time
    /// (`collect_session_data`); on restore, the frontend re-derives the id
    /// for the same file and compares it against this recorded value. A
    /// mismatch means the file's content changed since the save — same path,
    /// different bytes — so any analysis reference keyed to the old id is now
    /// unresolved. Additive and optional like `source_type_override`: a
    /// manifest written before this field existed parses as `None`, which the
    /// frontend treats as "nothing to diagnose" rather than a mismatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expected_session_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Pipeline chain (workspace-level)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LtwPipelineChain {
    pub chain: Vec<String>,
    pub disabled_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// Editor tabs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LtwEditorTab {
    pub label: String,
    pub content: String,
    pub view_mode: String,
    pub word_wrap: bool,
    pub file_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Layout (opaque JSON — frontend owns the structure)
// ---------------------------------------------------------------------------

/// Layout is stored as opaque JSON. The backend doesn't interpret it;
/// the frontend serializes/deserializes its own layout state.
pub type LtwLayout = serde_json::Value;

// ---------------------------------------------------------------------------
// Per-session data
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct LtwSessionData {
    pub bookmarks: Vec<Bookmark>,
    /// Legacy per-session analyses — populated only when reading a
    /// pre-migration `.ltw` whose analyses were stored per-session. Current
    /// writers always emit `[]` for this slot (see module doc); analyses now
    /// live in the workspace-level [`LtwData::analyses`]. Retained here so
    /// callers can migrate old data forward on load.
    pub analyses: Vec<AnalysisArtifact>,
    pub session_meta: SessionMeta,
}

// ---------------------------------------------------------------------------
// Complete workspace data
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct LtwData {
    pub manifest: LtwManifest,
    pub sessions: Vec<LtwSessionData>,
    /// Workspace-level analyses (top-level `analyses.json`). Empty when the
    /// entry is absent from the archive — a pre-migration `.ltw` file has no
    /// top-level `analyses.json`; its analyses live per-session instead, in
    /// each [`LtwSessionData::analyses`].
    pub analyses: Vec<AnalysisArtifact>,
    pub pipeline_chain: LtwPipelineChain,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/// Write a `.ltw` v4 file. Returns the `saved_at` epoch-millis stamped into the
/// manifest, so a caller (e.g. the Q4 background flush) can record the exact
/// same value into `app-state.json` — Q3's trust check compares the two and
/// tolerates only a small skew.
#[allow(clippy::too_many_arguments)]
pub fn write_ltw(
    dest: &Path,
    workspace_name: &str,
    workspace_id: Option<&str>,
    session_entries: &[(LtwManifestSession, &[Bookmark], &SessionMeta)],
    workspace_analyses: &[AnalysisArtifact],
    pipeline_chain: &LtwPipelineChain,
    editor_tabs: &[LtwEditorTab],
    layout: Option<&LtwLayout>,
) -> Result<i64, String> {
    let saved_at = now_ms();
    let manifest = LtwManifest {
        format_version: LTW_V4_FORMAT_VERSION,
        workspace_name: workspace_name.to_string(),
        workspace_id: workspace_id.map(str::to_string),
        saved_at,
        sessions: session_entries.iter().map(|(m, _, _)| m.clone()).collect(),
    };

    // Written atomically: content lands in a sibling `.ltw.tmp` file first and
    // is only renamed over `dest` once fully flushed, so a crash or power loss
    // mid-write can never truncate the previous good auto-save (see
    // `workspace::write_atomic`).
    crate::workspace::write_atomic(dest, "ltw.tmp", |out_file| {
        let mut writer = zip::ZipWriter::new(out_file);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // Manifest
        zip_write_json(&mut writer, "manifest.json", opts, &manifest)?;

        // Workspace-level analyses
        zip_write_json(&mut writer, "analyses.json", opts, workspace_analyses)?;

        // Per-session data. `sessions/{idx}/analyses.json` is always written as
        // an empty array — analyses moved to the top-level entry above, but
        // older builds still read this path with a hard `?`; omitting it would
        // make a downgraded reader fail to open the whole workspace (see
        // module doc).
        let empty_session_analyses: Vec<AnalysisArtifact> = Vec::new();
        for (idx, (_, bookmarks, meta)) in session_entries.iter().enumerate() {
            let prefix = format!("sessions/{idx}");
            zip_write_json(&mut writer, &format!("{prefix}/bookmarks.json"), opts, bookmarks)?;
            zip_write_json(&mut writer, &format!("{prefix}/analyses.json"), opts, &empty_session_analyses)?;
            zip_write_json(&mut writer, &format!("{prefix}/pipeline-meta.json"), opts, meta)?;
        }

        // Workspace-level data
        zip_write_json(&mut writer, "pipeline-chain.json", opts, pipeline_chain)?;
        zip_write_json(&mut writer, "editor-tabs.json", opts, editor_tabs)?;

        if let Some(layout_val) = layout {
            zip_write_json(&mut writer, "layout.json", opts, layout_val)?;
        }

        writer
            .finish()
            .map_err(|e| format!("Failed to finalise workspace zip: {e}"))
    })?;

    Ok(saved_at)
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

pub fn read_ltw(path: &Path) -> Result<LtwData, String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open workspace '{}': {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Invalid workspace zip '{}': {e}", path.display()))?;

    let manifest: LtwManifest = zip_read_json(&mut archive, "manifest.json")?;

    if manifest.format_version != LTW_V4_FORMAT_VERSION {
        return Err(format!(
            "Unsupported workspace format version {} (expected {LTW_V4_FORMAT_VERSION})",
            manifest.format_version
        ));
    }

    // Top-level workspace analyses. Tolerant like `layout.json` below: a
    // pre-migration `.ltw` has no `analyses.json` entry at all, and must still
    // load — with its analyses surfaced per-session instead (see below).
    let analyses: Vec<AnalysisArtifact> =
        zip_read_json(&mut archive, "analyses.json").unwrap_or_default();

    let session_count = manifest.sessions.len();
    let mut sessions = Vec::with_capacity(session_count);
    for idx in 0..session_count {
        let prefix = format!("sessions/{idx}");
        let bookmarks: Vec<Bookmark> =
            zip_read_json(&mut archive, &format!("{prefix}/bookmarks.json"))?;
        // Legacy per-session analyses. Current writers always emit `[]` here
        // (see module doc), but a pre-migration file may have real data and
        // may even predate this entry existing at all — tolerant like the
        // top-level read above.
        let legacy_analyses: Vec<AnalysisArtifact> =
            zip_read_json(&mut archive, &format!("{prefix}/analyses.json")).unwrap_or_default();
        let session_meta: SessionMeta =
            zip_read_json(&mut archive, &format!("{prefix}/pipeline-meta.json"))?;
        sessions.push(LtwSessionData {
            bookmarks,
            analyses: legacy_analyses,
            session_meta,
        });
    }

    let pipeline_chain: LtwPipelineChain =
        zip_read_json(&mut archive, "pipeline-chain.json")?;
    let editor_tabs: Vec<LtwEditorTab> =
        zip_read_json(&mut archive, "editor-tabs.json")?;

    let layout: Option<LtwLayout> = zip_read_json(&mut archive, "layout.json").ok();

    Ok(LtwData {
        manifest,
        sessions,
        analyses,
        pipeline_chain,
        editor_tabs,
        layout,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::bookmark::CreatedBy;
    use tempfile::NamedTempFile;

    fn make_bookmark(session_id: &str, line: u32, label: &str) -> Bookmark {
        Bookmark {
            id: format!("bk-{line}"),
            session_id: session_id.to_string(),
            line_number: line,
            line_number_end: None,
            snippet: None,
            category: None,
            tags: None,
            label: label.to_string(),
            note: String::new(),
            created_by: CreatedBy::User,
            created_at: 0,
        }
    }

    fn make_analysis(title: &str) -> AnalysisArtifact {
        AnalysisArtifact {
            id: format!("art-{title}"),
            title: title.to_string(),
            created_at: 0,
            sections: vec![],
            legacy_session_id: None,
        }
    }

    #[test]
    fn round_trip_empty_workspace() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        write_ltw(
            path,
            "Empty",
            None,
            &[],
            &[],
            &LtwPipelineChain::default(),
            &[],
            None,
        )
        .unwrap();

        let data = read_ltw(path).unwrap();
        assert_eq!(data.manifest.format_version, LTW_V4_FORMAT_VERSION);
        assert_eq!(data.manifest.workspace_name, "Empty");
        assert!(data.manifest.workspace_id.is_none());
        assert!(data.sessions.is_empty());
        assert!(data.analyses.is_empty());
        assert!(data.pipeline_chain.chain.is_empty());
        assert!(data.editor_tabs.is_empty());
        assert!(data.layout.is_none());
    }

    /// The override must survive a save/load cycle, and a detected-type session
    /// must persist nothing — replaying a detected type would freeze detection
    /// for that workspace, so a later fix to the detector could never reach it.
    /// Also pins backward compatibility: a manifest written before the field
    /// existed still reads, with the override absent.
    #[test]
    fn round_trip_source_type_override() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let no_bookmarks: Vec<Bookmark> = vec![];
        let meta = SessionMeta::default();
        let entries = vec![
            (
                LtwManifestSession {
                    file_path: "/logs/dumpstate_board.txt".into(),
                    source_name: "dumpstate_board.txt".into(),
                    source_type: "Kernel".into(),
                    source_type_override: Some("Kernel".into()),
                    expected_session_id: None,
                },
                no_bookmarks.as_slice(),
                &meta,
            ),
            (
                LtwManifestSession {
                    file_path: "/logs/device.log".into(),
                    source_name: "device.log".into(),
                    source_type: "Logcat".into(),
                    source_type_override: None,
                    expected_session_id: None,
                },
                no_bookmarks.as_slice(),
                &meta,
            ),
        ];

        write_ltw(
            path,
            "Overrides",
            None,
            &entries,
            &[],
            &LtwPipelineChain::default(),
            &[],
            None,
        )
        .unwrap();

        let data = read_ltw(path).unwrap();
        assert_eq!(
            data.manifest.sessions[0].source_type_override.as_deref(),
            Some("Kernel"),
            "an explicit override must survive the round trip"
        );
        assert_eq!(
            data.manifest.sessions[1].source_type_override, None,
            "a detected type must persist no override"
        );
    }

    /// A `.ltw` written before `sourceTypeOverride` existed must still parse.
    #[test]
    fn manifest_session_without_override_field_still_deserializes() {
        let json = r#"{
            "filePath": "/logs/device.log",
            "sourceName": "device.log",
            "sourceType": "Logcat"
        }"#;
        let parsed: LtwManifestSession = serde_json::from_str(json).expect("legacy entry parses");
        assert_eq!(parsed.source_type_override, None);
        assert_eq!(parsed.source_type, "Logcat");
    }

    /// The recorded id must survive a save/load cycle, and an entry with no
    /// recorded id (the writer never stamps `None`, but a hand-built manifest
    /// might) must round-trip as `None` rather than erroring or defaulting to
    /// something else.
    #[test]
    fn round_trip_expected_session_id() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let no_bookmarks: Vec<Bookmark> = vec![];
        let meta = SessionMeta::default();
        let entries = vec![
            (
                LtwManifestSession {
                    file_path: "/logs/device.log".into(),
                    source_name: "device.log".into(),
                    source_type: "Logcat".into(),
                    source_type_override: None,
                    expected_session_id: Some("f-abc123".into()),
                },
                no_bookmarks.as_slice(),
                &meta,
            ),
            (
                LtwManifestSession {
                    file_path: "/logs/kernel.log".into(),
                    source_name: "kernel.log".into(),
                    source_type: "Kernel".into(),
                    source_type_override: None,
                    expected_session_id: None,
                },
                no_bookmarks.as_slice(),
                &meta,
            ),
        ];

        write_ltw(
            path,
            "ExpectedIds",
            None,
            &entries,
            &[],
            &LtwPipelineChain::default(),
            &[],
            None,
        )
        .unwrap();

        let data = read_ltw(path).unwrap();
        assert_eq!(
            data.manifest.sessions[0].expected_session_id.as_deref(),
            Some("f-abc123"),
            "a recorded id must survive the round trip"
        );
        assert_eq!(
            data.manifest.sessions[1].expected_session_id, None,
            "an absent id must round-trip as None"
        );
    }

    /// A `.ltw` written before `expectedSessionId` existed must still parse.
    #[test]
    fn manifest_session_without_expected_session_id_still_deserializes() {
        let json = r#"{
            "filePath": "/logs/device.log",
            "sourceName": "device.log",
            "sourceType": "Logcat"
        }"#;
        let parsed: LtwManifestSession = serde_json::from_str(json).expect("legacy entry parses");
        assert_eq!(parsed.expected_session_id, None);
        assert_eq!(parsed.source_type, "Logcat");
    }

    #[test]
    fn round_trip_multi_session_workspace() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let bk1 = vec![make_bookmark("s1", 10, "crash site")];
        let bk2 = vec![make_bookmark("s2", 50, "wifi disconnect")];
        let workspace_analyses = vec![make_analysis("Crash Analysis")];
        let meta1 = SessionMeta {
            active_processor_ids: vec!["wifi-state".into()],
            disabled_processor_ids: vec![],
        };
        let meta2 = SessionMeta::default();

        let session_entries = vec![
            (
                LtwManifestSession {
                    file_path: "/logs/device-a.log".into(),
                    source_name: "device-a.log".into(),
                    source_type: "Logcat".into(),
                    source_type_override: None,
                    expected_session_id: None,
                },
                bk1.as_slice(),
                &meta1,
            ),
            (
                LtwManifestSession {
                    file_path: "/logs/bugreport.zip".into(),
                    source_name: "bugreport.zip".into(),
                    source_type: "Bugreport".into(),
                    source_type_override: None,
                    expected_session_id: None,
                },
                bk2.as_slice(),
                &meta2,
            ),
        ];

        let chain = LtwPipelineChain {
            chain: vec!["wifi-state".into(), "anr-detector".into()],
            disabled_ids: vec!["anr-detector".into()],
        };

        let editors = vec![LtwEditorTab {
            label: "Notes".into(),
            content: "# Investigation\nWiFi drops at 12:03".into(),
            view_mode: "editor".into(),
            word_wrap: true,
            file_path: None,
        }];

        let layout = serde_json::json!({
            "centerTree": { "type": "leaf", "id": "p1" },
            "leftPaneWidth": 280
        });

        write_ltw(
            path,
            "wifi-debug",
            Some("ws-wifi-debug"),
            &session_entries,
            &workspace_analyses,
            &chain,
            &editors,
            Some(&layout),
        )
        .unwrap();

        let data = read_ltw(path).unwrap();

        // Manifest
        assert_eq!(data.manifest.workspace_name, "wifi-debug");
        assert_eq!(data.manifest.workspace_id.as_deref(), Some("ws-wifi-debug"));
        assert_eq!(data.manifest.sessions.len(), 2);
        assert_eq!(data.manifest.sessions[0].file_path, "/logs/device-a.log");
        assert_eq!(data.manifest.sessions[0].source_type, "Logcat");
        assert_eq!(data.manifest.sessions[1].file_path, "/logs/bugreport.zip");
        assert_eq!(data.manifest.sessions[1].source_type, "Bugreport");

        // Workspace-level analyses (top-level, no longer per-session)
        assert_eq!(data.analyses.len(), 1);
        assert_eq!(data.analyses[0].title, "Crash Analysis");

        // Per-session data
        assert_eq!(data.sessions[0].bookmarks.len(), 1);
        assert_eq!(data.sessions[0].bookmarks[0].label, "crash site");
        assert!(
            data.sessions[0].analyses.is_empty(),
            "new files always write empty per-session analyses"
        );
        assert_eq!(data.sessions[0].session_meta.active_processor_ids, vec!["wifi-state"]);
        assert_eq!(data.sessions[1].bookmarks.len(), 1);
        assert_eq!(data.sessions[1].bookmarks[0].label, "wifi disconnect");
        assert!(data.sessions[1].analyses.is_empty());

        // Pipeline chain
        assert_eq!(data.pipeline_chain.chain, vec!["wifi-state", "anr-detector"]);
        assert_eq!(data.pipeline_chain.disabled_ids, vec!["anr-detector"]);

        // Editor tabs
        assert_eq!(data.editor_tabs.len(), 1);
        assert_eq!(data.editor_tabs[0].label, "Notes");
        assert!(data.editor_tabs[0].content.contains("WiFi drops"));

        // Layout
        assert!(data.layout.is_some());
        let layout_val = data.layout.unwrap();
        assert_eq!(layout_val["leftPaneWidth"], 280);
    }

    #[test]
    fn rejects_wrong_format_version() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        // Write a v4 file then tamper with the version
        write_ltw(path, "test", None, &[], &[], &LtwPipelineChain::default(), &[], None).unwrap();

        // Read it back, modify manifest version, rewrite
        let file = File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut manifest: LtwManifest = zip_read_json(&mut archive, "manifest.json").unwrap();
        drop(archive);

        manifest.format_version = 99;
        let out = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(out);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip_write_json(&mut writer, "manifest.json", opts, &manifest).unwrap();
        zip_write_json(&mut writer, "pipeline-chain.json", opts, &LtwPipelineChain::default()).unwrap();
        zip_write_json(&mut writer, "editor-tabs.json", opts, &Vec::<LtwEditorTab>::new()).unwrap();
        writer.finish().unwrap();

        let result = read_ltw(path);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported workspace format version 99"));
    }

    #[test]
    fn layout_is_optional() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        write_ltw(path, "no-layout", None, &[], &[], &LtwPipelineChain::default(), &[], None).unwrap();

        let data = read_ltw(path).unwrap();
        assert!(data.layout.is_none());
    }

    #[test]
    fn saved_at_is_recent() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();
        let before = now_ms();

        write_ltw(path, "timing", None, &[], &[], &LtwPipelineChain::default(), &[], None).unwrap();

        let data = read_ltw(path).unwrap();
        assert!(data.manifest.saved_at >= before);
        assert!(data.manifest.saved_at <= now_ms());
    }

    #[test]
    fn round_trip_workspace_id_present_and_absent() {
        // With an id (the modern writer path — both save commands and the
        // backend flusher pass their workspace id).
        let with_id = NamedTempFile::new().unwrap();
        write_ltw(with_id.path(), "ws", Some("ws-42"), &[], &[], &LtwPipelineChain::default(), &[], None).unwrap();
        assert_eq!(read_ltw(with_id.path()).unwrap().manifest.workspace_id.as_deref(), Some("ws-42"));

        // Without an id (writer explicitly passes None) — round-trips to None.
        let no_id = NamedTempFile::new().unwrap();
        write_ltw(no_id.path(), "ws", None, &[], &[], &LtwPipelineChain::default(), &[], None).unwrap();
        assert!(read_ltw(no_id.path()).unwrap().manifest.workspace_id.is_none());
    }

    #[test]
    fn legacy_manifest_without_workspace_id_field_parses() {
        // A manifest.json written before `workspaceId` existed omits the field
        // entirely. `#[serde(default)]` must let it parse (as None) rather than
        // failing — that legacy file is exactly what Q3's trust gate guards.
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let legacy_manifest = serde_json::json!({
            "formatVersion": LTW_V4_FORMAT_VERSION,
            "workspaceName": "Untitled",
            "savedAt": 1_700_000_000_000i64,
            "sessions": []
            // note: no "workspaceId" key
        });

        let out = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(out);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip_write_json(&mut writer, "manifest.json", opts, &legacy_manifest).unwrap();
        zip_write_json(&mut writer, "pipeline-chain.json", opts, &LtwPipelineChain::default()).unwrap();
        zip_write_json(&mut writer, "editor-tabs.json", opts, &Vec::<LtwEditorTab>::new()).unwrap();
        writer.finish().unwrap();

        let data = read_ltw(path).unwrap();
        assert_eq!(data.manifest.workspace_name, "Untitled");
        assert!(data.manifest.workspace_id.is_none());
    }

    // --- Workspace-level analyses (T3) -------------------------------------

    /// A single artifact can reference two different sessions — analyses are
    /// workspace-owned, not keyed by session, so this must round-trip as one
    /// entry in the top-level `analyses.json`, not duplicated per session.
    #[test]
    fn round_trip_workspace_analyses_spanning_two_sessions() {
        use crate::core::analysis::{AnalysisSection, HighlightType, SourceReference};

        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let artifact = AnalysisArtifact {
            id: "art-multi".into(),
            title: "Cross-session correlation".into(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "H".into(),
                body: "B".into(),
                references: vec![
                    SourceReference {
                        line_number: 1,
                        end_line: None,
                        label: "in s1".into(),
                        highlight_type: HighlightType::default(),
                        session_id: Some("s1".into()),
                    },
                    SourceReference {
                        line_number: 2,
                        end_line: None,
                        label: "in s2".into(),
                        highlight_type: HighlightType::default(),
                        session_id: Some("s2".into()),
                    },
                ],
                severity: None,
            }],
            legacy_session_id: None,
        };
        let workspace_analyses = vec![artifact];

        write_ltw(path, "multi", None, &[], &workspace_analyses, &LtwPipelineChain::default(), &[], None)
            .unwrap();

        let data = read_ltw(path).unwrap();
        assert_eq!(data.analyses.len(), 1);
        assert_eq!(data.analyses[0].id, "art-multi");
        let session_ids = crate::core::analysis::artifact_session_ids(&data.analyses[0]);
        assert_eq!(session_ids, vec!["s1".to_string(), "s2".to_string()]);
    }

    /// A pre-migration `.ltw` with no top-level `analyses.json` but real data
    /// in `sessions/{idx}/analyses.json` must surface that data in
    /// `LtwSessionData::analyses` for migration, while the top-level
    /// `LtwData::analyses` reads as empty (no expectation recorded there).
    #[test]
    fn legacy_ltw_with_per_session_analyses_reads_them_into_session_data() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let manifest = LtwManifest {
            format_version: LTW_V4_FORMAT_VERSION,
            workspace_name: "legacy".into(),
            workspace_id: None,
            saved_at: 1_700_000_000_000,
            sessions: vec![LtwManifestSession {
                file_path: "/logs/a.log".into(),
                source_name: "a.log".into(),
                source_type: "Logcat".into(),
                source_type_override: None,
                expected_session_id: None,
            }],
        };

        let legacy_artifact = make_analysis("Legacy Analysis");

        let out = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(out);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip_write_json(&mut writer, "manifest.json", opts, &manifest).unwrap();
        zip_write_json(&mut writer, "sessions/0/bookmarks.json", opts, &Vec::<Bookmark>::new()).unwrap();
        zip_write_json(&mut writer, "sessions/0/analyses.json", opts, &vec![legacy_artifact]).unwrap();
        zip_write_json(&mut writer, "sessions/0/pipeline-meta.json", opts, &SessionMeta::default()).unwrap();
        zip_write_json(&mut writer, "pipeline-chain.json", opts, &LtwPipelineChain::default()).unwrap();
        zip_write_json(&mut writer, "editor-tabs.json", opts, &Vec::<LtwEditorTab>::new()).unwrap();
        // Deliberately no top-level "analyses.json" — this is the pre-migration shape.
        writer.finish().unwrap();

        let data = read_ltw(path).unwrap();
        assert!(
            data.analyses.is_empty(),
            "no top-level analyses.json in this legacy file"
        );
        assert_eq!(data.sessions[0].analyses.len(), 1);
        assert_eq!(data.sessions[0].analyses[0].title, "Legacy Analysis");
    }

    /// A `.ltw` with no top-level `analyses.json` entry at all (and no
    /// per-session data either) must still open, with analyses reading as
    /// empty rather than erroring.
    #[test]
    fn ltw_without_top_level_analyses_json_reads_as_empty() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let manifest = LtwManifest {
            format_version: LTW_V4_FORMAT_VERSION,
            workspace_name: "no-analyses-entry".into(),
            workspace_id: None,
            saved_at: 1_700_000_000_000,
            sessions: vec![],
        };

        let out = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(out);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip_write_json(&mut writer, "manifest.json", opts, &manifest).unwrap();
        zip_write_json(&mut writer, "pipeline-chain.json", opts, &LtwPipelineChain::default()).unwrap();
        zip_write_json(&mut writer, "editor-tabs.json", opts, &Vec::<LtwEditorTab>::new()).unwrap();
        // Deliberately no "analyses.json" entry.
        writer.finish().unwrap();

        let data = read_ltw(path).unwrap();
        assert!(data.analyses.is_empty());
    }

    /// The current writer must always emit `sessions/{idx}/analyses.json` as
    /// an empty array, even when the workspace has real analyses — older
    /// builds read that path with a hard `?`, so omitting it (or leaving it
    /// non-empty and duplicated) would break a downgraded reader opening the
    /// workspace.
    #[test]
    fn new_writer_emits_empty_per_session_analyses_for_downgrade_readers() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let no_bookmarks: Vec<Bookmark> = vec![];
        let meta = SessionMeta::default();
        let entries = vec![(
            LtwManifestSession {
                file_path: "/logs/a.log".into(),
                source_name: "a.log".into(),
                source_type: "Logcat".into(),
                source_type_override: None,
                expected_session_id: None,
            },
            no_bookmarks.as_slice(),
            &meta,
        )];

        let workspace_analyses = vec![make_analysis("Workspace-level")];

        write_ltw(
            path,
            "downgrade-check",
            None,
            &entries,
            &workspace_analyses,
            &LtwPipelineChain::default(),
            &[],
            None,
        )
        .unwrap();

        let file = File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let session_analyses: Vec<AnalysisArtifact> =
            zip_read_json(&mut archive, "sessions/0/analyses.json").unwrap();
        assert!(
            session_analyses.is_empty(),
            "new writer must always emit an empty per-session analyses.json for downgrade readers"
        );
    }
}
