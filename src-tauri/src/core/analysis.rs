use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// How a source reference should be displayed in the gutter.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
pub enum HighlightType {
    /// A background annotation (subtle highlight).
    #[default]
    Annotation,
    /// An anchor point (prominent marker).
    Anchor,
}

/// Severity level for an analysis section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
pub enum Severity {
    Info,
    Warning,
    Error,
    Critical,
}

/// A reference to a specific location in the log source.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceReference {
    pub line_number: u32,
    pub end_line: Option<u32>,
    pub label: String,
    #[serde(default)]
    pub highlight_type: HighlightType,
    /// Which session this reference's line numbers resolve against.
    /// `None` means unattributed/unresolved — deserializes to `None` when the
    /// field is absent (old payloads), and must still serialize the key as
    /// `sessionId: null` rather than omitting it, so consumers can distinguish
    /// "field not sent" (old client) from "explicitly unattributed".
    #[serde(default)]
    pub session_id: Option<String>,
}

/// One section of a structured analysis artifact.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSection {
    pub heading: String,
    pub body: String,
    /// Optional — a prose-only section (a conclusion, a recommendations list)
    /// legitimately has no line anchors. The MCP schema advertises this as
    /// optional, so the deserializer must accept its absence.
    #[serde(default)]
    pub references: Vec<SourceReference>,
    pub severity: Option<Severity>,
}

/// A structured narrative with citations, published by an agent or user.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisArtifact {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub created_at: i64,
    pub sections: Vec<AnalysisSection>,
    /// Read-compat only for old artifact-level `{"sessionId": "..."}` payloads
    /// (before session attribution moved onto individual `SourceReference`s).
    /// Never written by new code — an explicit `rename` here (rather than
    /// relying on the container's `rename_all`) so old archives still parse
    /// even after this field is renamed away from `session_id`. Callers that
    /// need a fallback session id for an artifact with no per-reference
    /// attribution should read this once via [`migrate_artifact`], which
    /// clears it after stamping.
    #[serde(default, rename = "sessionId", skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub legacy_session_id: Option<String>,
}

/// Payload emitted as `analysis-update` Tauri event.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisUpdateEvent {
    pub artifact_id: String,
    pub action: String,
    /// All session ids this update is relevant to (deduped, first-seen order).
    pub session_ids: Vec<String>,
    /// Best-effort single session id for consumers that only track one
    /// focused session at a time. `None` when the artifact has no resolvable
    /// session attribution yet.
    pub session_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Migration primitives
// ---------------------------------------------------------------------------
//
// Session attribution used to live on `AnalysisArtifact` as a single
// mandatory `session_id`. It now lives per-reference on `SourceReference`,
// so a single artifact can carry references into multiple sessions (or none
// yet, if unattributed). These helpers bridge old data into the new shape.

/// Stamp every reference in `artifact` that lacks a `session_id`.
///
/// Precedence per reference: an existing `reference.session_id` is left
/// alone; otherwise `fallback` is used; otherwise the artifact's
/// `legacy_session_id` (from an old artifact-level payload) is used. After
/// stamping, `legacy_session_id` is always cleared — it is read-compat only
/// and must never linger once its value has been consumed (or superseded by
/// `fallback`).
///
/// Idempotent: a second call finds no reference lacking `session_id` and
/// `legacy_session_id` already `None`, so it is a no-op.
pub fn migrate_artifact(artifact: &mut AnalysisArtifact, fallback: Option<&str>) {
    let resolved: Option<String> = fallback
        .map(str::to_string)
        .or_else(|| artifact.legacy_session_id.clone());

    if let Some(sid) = &resolved {
        for section in &mut artifact.sections {
            for reference in &mut section.references {
                if reference.session_id.is_none() {
                    reference.session_id = Some(sid.clone());
                }
            }
        }
    }

    artifact.legacy_session_id = None;
}

/// Every distinct session id referenced anywhere in `artifact`, deduped and
/// in first-seen order. References without a resolved `session_id` are
/// skipped.
pub fn artifact_session_ids(artifact: &AnalysisArtifact) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut ids = Vec::new();
    for section in &artifact.sections {
        for reference in &section.references {
            if let Some(sid) = &reference.session_id {
                if seen.insert(sid.clone()) {
                    ids.push(sid.clone());
                }
            }
        }
    }
    ids
}

/// Whether `artifact` is relevant to `session_id`.
///
/// True if any reference is attributed to `session_id`, OR if `artifact` has
/// no references at all across any section. A no-reference artifact (a
/// narrative-only publish — conclusion, summary, recommendations, with no
/// line anchors) has no file anchor to disambiguate by, so it is treated as
/// relevant to every session rather than to none: it appears in every
/// session-filtered list and every `.lts` export, matching how a reader would
/// expect a session-scoped view to include analyses that don't happen to cite
/// a specific line. This does NOT affect the unfiltered workspace list
/// (`list_analyses(None)` / `GET /mcp/analyses`), which already returns every
/// artifact regardless of references.
pub fn artifact_references_session(artifact: &AnalysisArtifact, session_id: &str) -> bool {
    let mut has_any_reference = false;
    for section in &artifact.sections {
        for reference in &section.references {
            has_any_reference = true;
            if reference.session_id.as_deref() == Some(session_id) {
                return true;
            }
        }
    }
    !has_any_reference
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_artifact() -> AnalysisArtifact {
        AnalysisArtifact {
            id: "art-1".to_string(),
            title: "FD Leak Analysis".to_string(),
            created_at: 2000,
            sections: vec![
                AnalysisSection {
                    heading: "Overview".to_string(),
                    body: "Found **3** FD leak sources.".to_string(),
                    references: vec![],
                    severity: Some(Severity::Warning),
                },
                AnalysisSection {
                    heading: "Detail".to_string(),
                    body: "Process X opens sockets without closing.".to_string(),
                    references: vec![
                        SourceReference {
                            line_number: 100,
                            end_line: Some(120),
                            label: "FD spike starts".to_string(),
                            highlight_type: HighlightType::Anchor,
                            session_id: Some("sess-1".to_string()),
                        },
                        SourceReference {
                            line_number: 500,
                            end_line: None,
                            label: "EBADF error".to_string(),
                            highlight_type: HighlightType::Annotation,
                            session_id: None,
                        },
                    ],
                    severity: Some(Severity::Error),
                },
            ],
            legacy_session_id: None,
        }
    }

    /// Builds a single-section artifact from raw references, for the
    /// migration-helper tests below.
    fn artifact_with_refs(refs: Vec<SourceReference>, legacy: Option<&str>) -> AnalysisArtifact {
        AnalysisArtifact {
            id: "art-x".to_string(),
            title: "T".to_string(),
            created_at: 0,
            sections: vec![AnalysisSection {
                heading: "H".to_string(),
                body: "B".to_string(),
                references: refs,
                severity: None,
            }],
            legacy_session_id: legacy.map(str::to_string),
        }
    }

    fn make_reference(line: u32, session_id: Option<&str>) -> SourceReference {
        SourceReference {
            line_number: line,
            end_line: None,
            label: format!("ref-{line}"),
            highlight_type: HighlightType::default(),
            session_id: session_id.map(str::to_string),
        }
    }

    #[test]
    fn artifact_serde_roundtrip() {
        let art = make_artifact();
        let json = serde_json::to_string(&art).unwrap();
        let parsed: AnalysisArtifact = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.title, "FD Leak Analysis");
        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(parsed.sections[1].references.len(), 2);
    }

    // ── Optional fields the MCP schema advertises as optional ────────────────
    // A publish whose section omits `references` previously failed with
    // HTTP 422 "missing field `references`". Prose-only sections (a conclusion,
    // a recommendations list) have no line anchors and must deserialize.

    #[test]
    fn section_deserializes_without_references() {
        let json = r#"{"heading":"Conclusion","body":"Signal integrity, not power.","severity":"Critical"}"#;
        let section: AnalysisSection = serde_json::from_str(json).unwrap();
        assert_eq!(section.heading, "Conclusion");
        assert!(section.references.is_empty());
        assert_eq!(section.severity, Some(Severity::Critical));
    }

    #[test]
    fn section_deserializes_without_references_or_severity() {
        let json = r#"{"heading":"Next steps","body":"Swap the cable first."}"#;
        let section: AnalysisSection = serde_json::from_str(json).unwrap();
        assert!(section.references.is_empty());
        assert!(section.severity.is_none());
    }

    #[test]
    fn artifact_deserializes_with_mixed_reference_presence() {
        // Mirrors a real publish: anchored sections alongside prose-only ones.
        let json = r#"{
            "id":"a1","sessionId":"s1","title":"USB","createdAt":1,
            "sections":[
                {"heading":"Conclusion","body":"..."},
                {"heading":"Evidence","body":"...","references":[
                    {"lineNumber":60345,"label":"enumerated","highlightType":"Anchor"}
                ]}
            ]
        }"#;
        let art: AnalysisArtifact = serde_json::from_str(json).unwrap();
        assert_eq!(art.sections.len(), 2);
        assert!(art.sections[0].references.is_empty());
        assert_eq!(art.sections[1].references.len(), 1);
        assert_eq!(art.sections[1].references[0].line_number, 60345);
    }

    #[test]
    fn reference_deserializes_without_highlight_type_or_end_line() {
        let json = r#"{"lineNumber":42,"label":"here"}"#;
        let r: SourceReference = serde_json::from_str(json).unwrap();
        assert_eq!(r.line_number, 42);
        assert!(r.end_line.is_none());
        assert_eq!(r.highlight_type, HighlightType::default());
    }

    #[test]
    fn reference_without_session_id_defaults_to_none() {
        let json = r#"{"lineNumber":42,"label":"here"}"#;
        let r: SourceReference = serde_json::from_str(json).unwrap();
        assert_eq!(r.session_id, None);
    }

    #[test]
    fn reference_serializes_session_id_as_null_when_absent() {
        let r = make_reference(1, None);
        let val = serde_json::to_value(&r).unwrap();
        assert_eq!(
            val.get("sessionId"),
            Some(&serde_json::Value::Null),
            "sessionId must serialize as null, not be skipped, when absent"
        );
    }

    #[test]
    fn legacy_artifact_with_artifact_level_session_id_deserializes() {
        // Old artifact-level payloads carried `sessionId` on the artifact
        // itself, before attribution moved onto individual references.
        let json = r#"{
            "id":"art-old","sessionId":"sess-legacy","title":"Old shape","createdAt":1000,
            "sections":[]
        }"#;
        let art: AnalysisArtifact = serde_json::from_str(json).unwrap();
        assert_eq!(art.legacy_session_id.as_deref(), Some("sess-legacy"));
    }

    #[test]
    fn artifact_camel_case_serialization() {
        let art = make_artifact();
        let val: serde_json::Value = serde_json::to_value(&art).unwrap();
        assert!(val.get("createdAt").is_some());
        assert!(
            val.get("sessionId").is_none(),
            "legacy_session_id must not serialize when absent (skip_serializing_if)"
        );
        let sec = &val["sections"][1];
        let ref0 = &sec["references"][0];
        assert!(ref0.get("lineNumber").is_some());
        assert!(ref0.get("endLine").is_some());
        assert!(ref0.get("highlightType").is_some());
        assert_eq!(ref0["sessionId"], serde_json::json!("sess-1"));
    }

    #[test]
    fn source_reference_range() {
        let r = SourceReference {
            line_number: 50,
            end_line: Some(75),
            label: "range".to_string(),
            highlight_type: HighlightType::Annotation,
            session_id: None,
        };
        assert_eq!(r.end_line, Some(75));
    }

    #[test]
    fn source_reference_single_line() {
        let r = SourceReference {
            line_number: 50,
            end_line: None,
            label: "point".to_string(),
            highlight_type: HighlightType::Anchor,
            session_id: None,
        };
        assert_eq!(r.end_line, None);
    }

    // ── Migration primitives ──────────────────────────────────────────────

    #[test]
    fn migrate_stamps_unattributed_references_with_fallback() {
        let mut art = artifact_with_refs(vec![make_reference(1, None)], None);
        migrate_artifact(&mut art, Some("sess-fallback"));
        assert_eq!(
            art.sections[0].references[0].session_id.as_deref(),
            Some("sess-fallback")
        );
    }

    #[test]
    fn migrate_prefers_existing_reference_session_over_fallback() {
        let mut art = artifact_with_refs(vec![make_reference(1, Some("sess-existing"))], None);
        migrate_artifact(&mut art, Some("sess-fallback"));
        assert_eq!(
            art.sections[0].references[0].session_id.as_deref(),
            Some("sess-existing")
        );
    }

    #[test]
    fn migrate_falls_back_to_legacy_artifact_session_when_no_fallback() {
        let mut art = artifact_with_refs(vec![make_reference(1, None)], Some("sess-legacy"));
        migrate_artifact(&mut art, None);
        assert_eq!(
            art.sections[0].references[0].session_id.as_deref(),
            Some("sess-legacy")
        );
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut art = artifact_with_refs(
            vec![make_reference(1, None), make_reference(2, Some("sess-existing"))],
            Some("sess-legacy"),
        );
        migrate_artifact(&mut art, Some("sess-fallback"));
        let after_first: Vec<Option<String>> = art.sections[0]
            .references
            .iter()
            .map(|r| r.session_id.clone())
            .collect();
        migrate_artifact(&mut art, Some("sess-fallback"));
        let after_second: Vec<Option<String>> = art.sections[0]
            .references
            .iter()
            .map(|r| r.session_id.clone())
            .collect();
        assert_eq!(after_first, after_second);
    }

    #[test]
    fn migrate_clears_legacy_session_id() {
        let mut art = artifact_with_refs(vec![make_reference(1, None)], Some("sess-legacy"));
        migrate_artifact(&mut art, None);
        assert!(art.legacy_session_id.is_none());
    }

    #[test]
    fn artifact_session_ids_dedupes_and_preserves_order() {
        let art = artifact_with_refs(
            vec![
                make_reference(1, Some("sess-b")),
                make_reference(2, Some("sess-a")),
                make_reference(3, Some("sess-b")),
            ],
            None,
        );
        assert_eq!(
            artifact_session_ids(&art),
            vec!["sess-b".to_string(), "sess-a".to_string()]
        );
    }

    #[test]
    fn artifact_session_ids_skips_unresolved_references() {
        let art = artifact_with_refs(
            vec![make_reference(1, None), make_reference(2, Some("sess-a"))],
            None,
        );
        assert_eq!(artifact_session_ids(&art), vec!["sess-a".to_string()]);
    }

    // ── artifact_references_session ───────────────────────────────────────

    #[test]
    fn references_session_true_when_a_reference_matches() {
        let art = artifact_with_refs(vec![make_reference(1, Some("sess-a"))], None);
        assert!(artifact_references_session(&art, "sess-a"));
    }

    #[test]
    fn references_session_false_when_no_reference_matches() {
        let art = artifact_with_refs(vec![make_reference(1, Some("sess-b"))], None);
        assert!(!artifact_references_session(&art, "sess-a"));
    }

    /// A reference that exists but is unattributed (has an anchor, no
    /// resolved session) is NOT the same as an artifact with zero references
    /// — it must not match every session the way a no-reference artifact does.
    #[test]
    fn references_session_false_for_unattributed_reference_with_no_fallback() {
        let art = artifact_with_refs(vec![make_reference(1, None)], None);
        assert!(!artifact_references_session(&art, "sess-a"));
    }

    /// An artifact with NO references at all (a narrative-only publish — no
    /// line anchors) has no file anchor to disambiguate by, so it must be
    /// treated as relevant to every session.
    #[test]
    fn references_session_true_for_artifact_with_zero_references() {
        let art = artifact_with_refs(vec![], None);
        assert!(artifact_references_session(&art, "sess-a"));
        assert!(artifact_references_session(&art, "sess-anything-else"));
    }

    /// A multi-section artifact where every section's references list is
    /// empty is still "zero references" overall.
    #[test]
    fn references_session_true_when_all_sections_have_no_references() {
        let art = AnalysisArtifact {
            id: "art-multi-empty".to_string(),
            title: "T".to_string(),
            created_at: 0,
            sections: vec![
                AnalysisSection {
                    heading: "H1".to_string(),
                    body: "B1".to_string(),
                    references: vec![],
                    severity: None,
                },
                AnalysisSection {
                    heading: "H2".to_string(),
                    body: "B2".to_string(),
                    references: vec![],
                    severity: None,
                },
            ],
            legacy_session_id: None,
        };
        assert!(artifact_references_session(&art, "sess-a"));
    }

    #[test]
    fn severity_serde() {
        assert_eq!(serde_json::to_string(&Severity::Info).unwrap(), "\"Info\"");
        assert_eq!(serde_json::to_string(&Severity::Warning).unwrap(), "\"Warning\"");
        assert_eq!(serde_json::to_string(&Severity::Error).unwrap(), "\"Error\"");
        assert_eq!(serde_json::to_string(&Severity::Critical).unwrap(), "\"Critical\"");
    }

    #[test]
    fn highlight_type_serde() {
        assert_eq!(
            serde_json::to_string(&HighlightType::Annotation).unwrap(),
            "\"Annotation\""
        );
        assert_eq!(
            serde_json::to_string(&HighlightType::Anchor).unwrap(),
            "\"Anchor\""
        );
    }

    #[test]
    fn empty_artifact() {
        let art = AnalysisArtifact {
            id: "art-empty".to_string(),
            title: "Empty".to_string(),
            created_at: 0,
            sections: vec![],
            legacy_session_id: None,
        };
        let json = serde_json::to_string(&art).unwrap();
        let parsed: AnalysisArtifact = serde_json::from_str(&json).unwrap();
        assert!(parsed.sections.is_empty());
    }

    #[test]
    fn source_reference_missing_highlight_type_defaults_to_annotation() {
        let json = r#"{"lineNumber": 42, "label": "test point"}"#;
        let r: SourceReference = serde_json::from_str(json).unwrap();
        assert_eq!(r.highlight_type, HighlightType::Annotation);
        assert_eq!(r.line_number, 42);
        assert_eq!(r.end_line, None);
    }

    #[test]
    fn analysis_update_event_serde() {
        let event = AnalysisUpdateEvent {
            artifact_id: "art-1".to_string(),
            action: "published".to_string(),
            session_ids: vec!["sess-1".to_string(), "sess-2".to_string()],
            session_id: Some("sess-1".to_string()),
        };
        let val: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(val["action"], "published");
        assert!(val.get("artifactId").is_some());
        assert_eq!(val["sessionIds"], serde_json::json!(["sess-1", "sess-2"]));
        assert_eq!(val["sessionId"], serde_json::json!("sess-1"));
    }

    #[test]
    fn analysis_update_event_session_id_serializes_as_null_when_none() {
        let event = AnalysisUpdateEvent {
            artifact_id: "art-1".to_string(),
            action: "deleted".to_string(),
            session_ids: vec![],
            session_id: None,
        };
        let val: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(val.get("sessionId"), Some(&serde_json::Value::Null));
        assert_eq!(val["sessionIds"], serde_json::json!([]));
    }
}
