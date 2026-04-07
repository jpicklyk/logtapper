//! `.ltw` format version 4 — multi-session workspace with file references.
//!
//! Unlike v1 (single-file workspace) and `.lts` (embedded log data), this format
//! stores workspace state with **references** to log files on disk. No raw log data
//! is embedded, making files small (KB) and fast to save/load.
//!
//! ZIP layout:
//! ```text
//! manifest.json                        — workspace name, session list, timestamp
//! sessions/{idx}/bookmarks.json        — per-session bookmarks
//! sessions/{idx}/analyses.json         — per-session analyses
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

pub const LTW_V4_FORMAT_VERSION: u32 = 4;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtwManifest {
    pub format_version: u32,
    pub workspace_name: String,
    pub saved_at: i64,
    pub sessions: Vec<LtwManifestSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtwManifestSession {
    /// Absolute path to the log file on disk.
    pub file_path: String,
    /// Display name (filename portion).
    pub source_name: String,
    /// Source type: Logcat, Bugreport, Dumpstate, Kernel, Unknown.
    pub source_type: String,
}

// ---------------------------------------------------------------------------
// Pipeline chain (workspace-level)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtwPipelineChain {
    pub chain: Vec<String>,
    pub disabled_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// Editor tabs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub pipeline_chain: LtwPipelineChain,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

pub fn write_ltw(
    dest: &Path,
    workspace_name: &str,
    session_entries: &[(LtwManifestSession, &[Bookmark], &[AnalysisArtifact], &SessionMeta)],
    pipeline_chain: &LtwPipelineChain,
    editor_tabs: &[LtwEditorTab],
    layout: Option<&LtwLayout>,
) -> Result<(), String> {
    let manifest = LtwManifest {
        format_version: LTW_V4_FORMAT_VERSION,
        workspace_name: workspace_name.to_string(),
        saved_at: now_ms(),
        sessions: session_entries.iter().map(|(m, _, _, _)| m.clone()).collect(),
    };

    let out_file = File::create(dest)
        .map_err(|e| format!("Failed to create workspace file '{}': {e}", dest.display()))?;
    let mut writer = zip::ZipWriter::new(out_file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Manifest
    zip_write_json(&mut writer, "manifest.json", opts, &manifest)?;

    // Per-session data
    for (idx, (_, bookmarks, analyses, meta)) in session_entries.iter().enumerate() {
        let prefix = format!("sessions/{idx}");
        zip_write_json(&mut writer, &format!("{prefix}/bookmarks.json"), opts, bookmarks)?;
        zip_write_json(&mut writer, &format!("{prefix}/analyses.json"), opts, analyses)?;
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
        .map_err(|e| format!("Failed to finalise workspace zip: {e}"))?;

    Ok(())
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

    let session_count = manifest.sessions.len();
    let mut sessions = Vec::with_capacity(session_count);
    for idx in 0..session_count {
        let prefix = format!("sessions/{idx}");
        let bookmarks: Vec<Bookmark> =
            zip_read_json(&mut archive, &format!("{prefix}/bookmarks.json"))?;
        let analyses: Vec<AnalysisArtifact> =
            zip_read_json(&mut archive, &format!("{prefix}/analyses.json"))?;
        let session_meta: SessionMeta =
            zip_read_json(&mut archive, &format!("{prefix}/pipeline-meta.json"))?;
        sessions.push(LtwSessionData {
            bookmarks,
            analyses,
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

    fn make_analysis(session_id: &str, title: &str) -> AnalysisArtifact {
        AnalysisArtifact {
            id: format!("art-{title}"),
            session_id: session_id.to_string(),
            title: title.to_string(),
            created_at: 0,
            sections: vec![],
        }
    }

    #[test]
    fn round_trip_empty_workspace() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        write_ltw(
            path,
            "Empty",
            &[],
            &LtwPipelineChain::default(),
            &[],
            None,
        )
        .unwrap();

        let data = read_ltw(path).unwrap();
        assert_eq!(data.manifest.format_version, LTW_V4_FORMAT_VERSION);
        assert_eq!(data.manifest.workspace_name, "Empty");
        assert!(data.sessions.is_empty());
        assert!(data.pipeline_chain.chain.is_empty());
        assert!(data.editor_tabs.is_empty());
        assert!(data.layout.is_none());
    }

    #[test]
    fn round_trip_multi_session_workspace() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();

        let bk1 = vec![make_bookmark("s1", 10, "crash site")];
        let bk2 = vec![make_bookmark("s2", 50, "wifi disconnect")];
        let art1 = vec![make_analysis("s1", "Crash Analysis")];
        let no_analyses: Vec<AnalysisArtifact> = vec![];
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
                },
                bk1.as_slice(),
                art1.as_slice(),
                &meta1,
            ),
            (
                LtwManifestSession {
                    file_path: "/logs/bugreport.zip".into(),
                    source_name: "bugreport.zip".into(),
                    source_type: "Bugreport".into(),
                },
                bk2.as_slice(),
                no_analyses.as_slice(),
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

        write_ltw(path, "wifi-debug", &session_entries, &chain, &editors, Some(&layout)).unwrap();

        let data = read_ltw(path).unwrap();

        // Manifest
        assert_eq!(data.manifest.workspace_name, "wifi-debug");
        assert_eq!(data.manifest.sessions.len(), 2);
        assert_eq!(data.manifest.sessions[0].file_path, "/logs/device-a.log");
        assert_eq!(data.manifest.sessions[0].source_type, "Logcat");
        assert_eq!(data.manifest.sessions[1].file_path, "/logs/bugreport.zip");
        assert_eq!(data.manifest.sessions[1].source_type, "Bugreport");

        // Per-session data
        assert_eq!(data.sessions[0].bookmarks.len(), 1);
        assert_eq!(data.sessions[0].bookmarks[0].label, "crash site");
        assert_eq!(data.sessions[0].analyses.len(), 1);
        assert_eq!(data.sessions[0].analyses[0].title, "Crash Analysis");
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
        write_ltw(path, "test", &[], &LtwPipelineChain::default(), &[], None).unwrap();

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

        write_ltw(path, "no-layout", &[], &LtwPipelineChain::default(), &[], None).unwrap();

        let data = read_ltw(path).unwrap();
        assert!(data.layout.is_none());
    }

    #[test]
    fn saved_at_is_recent() {
        let tmp = NamedTempFile::new().unwrap();
        let path = tmp.path();
        let before = now_ms();

        write_ltw(path, "timing", &[], &LtwPipelineChain::default(), &[], None).unwrap();

        let data = read_ltw(path).unwrap();
        assert!(data.manifest.saved_at >= before);
        assert!(data.manifest.saved_at <= now_ms());
    }
}
