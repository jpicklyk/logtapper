use serde::{Deserialize, Serialize};

/// How a source reference should be displayed in the gutter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum HighlightType {
    /// A background annotation (subtle highlight).
    Annotation,
    /// An anchor point (prominent marker).
    Anchor,
}

/// Severity level for an analysis section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Error,
    Critical,
}

/// A reference to a specific location in the log source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReference {
    pub line_number: u32,
    pub end_line: Option<u32>,
    pub label: String,
    pub highlight_type: HighlightType,
}

/// One section of a structured analysis artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSection {
    pub heading: String,
    pub body: String,
    pub references: Vec<SourceReference>,
    pub severity: Option<Severity>,
}

/// A structured narrative with citations, published by an agent or user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisArtifact {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub created_at: i64,
    pub sections: Vec<AnalysisSection>,
}

/// Payload emitted as `analysis-update` Tauri event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisUpdateEvent {
    pub session_id: String,
    pub action: String,
    pub artifact_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_artifact() -> AnalysisArtifact {
        AnalysisArtifact {
            id: "art-1".to_string(),
            session_id: "sess-1".to_string(),
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
                        },
                        SourceReference {
                            line_number: 500,
                            end_line: None,
                            label: "EBADF error".to_string(),
                            highlight_type: HighlightType::Annotation,
                        },
                    ],
                    severity: Some(Severity::Error),
                },
            ],
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

    #[test]
    fn artifact_camel_case_serialization() {
        let art = make_artifact();
        let val: serde_json::Value = serde_json::to_value(&art).unwrap();
        assert!(val.get("sessionId").is_some());
        assert!(val.get("createdAt").is_some());
        let sec = &val["sections"][1];
        let ref0 = &sec["references"][0];
        assert!(ref0.get("lineNumber").is_some());
        assert!(ref0.get("endLine").is_some());
        assert!(ref0.get("highlightType").is_some());
    }

    #[test]
    fn source_reference_range() {
        let r = SourceReference {
            line_number: 50,
            end_line: Some(75),
            label: "range".to_string(),
            highlight_type: HighlightType::Annotation,
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
        };
        assert_eq!(r.end_line, None);
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
            session_id: "sess-1".to_string(),
            title: "Empty".to_string(),
            created_at: 0,
            sections: vec![],
        };
        let json = serde_json::to_string(&art).unwrap();
        let parsed: AnalysisArtifact = serde_json::from_str(&json).unwrap();
        assert!(parsed.sections.is_empty());
    }

    #[test]
    fn analysis_update_event_serde() {
        let event = AnalysisUpdateEvent {
            session_id: "sess-1".to_string(),
            action: "published".to_string(),
            artifact_id: "art-1".to_string(),
        };
        let val: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(val["action"], "published");
        assert!(val.get("sessionId").is_some());
        assert!(val.get("artifactId").is_some());
    }
}
