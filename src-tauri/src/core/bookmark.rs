use serde::{Deserialize, Serialize};

/// Who created the bookmark.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CreatedBy {
    User,
    Agent,
}

/// A lightweight line pin with an optional label and note.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub session_id: String,
    pub line_number: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number_end: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    pub label: String,
    pub note: String,
    pub created_by: CreatedBy,
    pub created_at: i64,
}

/// Payload emitted as `bookmark-update` Tauri event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkUpdateEvent {
    pub session_id: String,
    pub action: String,
    pub bookmark: Bookmark,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bookmark(line: u32) -> Bookmark {
        Bookmark {
            id: format!("bm-{line}"),
            session_id: "sess-1".to_string(),
            line_number: line,
            line_number_end: None,
            snippet: None,
            category: None,
            tags: None,
            label: format!("Label {line}"),
            note: String::new(),
            created_by: CreatedBy::User,
            created_at: 1000,
        }
    }

    #[test]
    fn bookmark_serde_roundtrip() {
        let bm = make_bookmark(42);
        let json = serde_json::to_string(&bm).unwrap();
        let parsed: Bookmark = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.line_number, 42);
        assert_eq!(parsed.label, "Label 42");
        assert_eq!(parsed.created_by, CreatedBy::User);
    }

    #[test]
    fn bookmark_camel_case_serialization() {
        let bm = make_bookmark(10);
        let val: serde_json::Value = serde_json::to_value(&bm).unwrap();
        assert!(val.get("lineNumber").is_some());
        assert!(val.get("sessionId").is_some());
        assert!(val.get("createdBy").is_some());
        assert!(val.get("createdAt").is_some());
    }

    #[test]
    fn created_by_variants() {
        let user_json = serde_json::to_string(&CreatedBy::User).unwrap();
        let agent_json = serde_json::to_string(&CreatedBy::Agent).unwrap();
        assert_eq!(user_json, "\"User\"");
        assert_eq!(agent_json, "\"Agent\"");
    }

    #[test]
    fn bookmark_update_event_serde() {
        let bm = make_bookmark(5);
        let event = BookmarkUpdateEvent {
            session_id: "sess-1".to_string(),
            action: "created".to_string(),
            bookmark: bm,
        };
        let val: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(val["action"], "created");
        assert!(val.get("sessionId").is_some());
        assert!(val.get("bookmark").is_some());
    }

    #[test]
    fn new_optional_fields_absent_when_none() {
        let bm = make_bookmark(7);
        let val: serde_json::Value = serde_json::to_value(&bm).unwrap();
        // Fields with skip_serializing_if = "Option::is_none" must be absent when None
        assert!(val.get("lineNumberEnd").is_none());
        assert!(val.get("snippet").is_none());
        assert!(val.get("category").is_none());
        assert!(val.get("tags").is_none());
    }

    #[test]
    fn new_optional_fields_present_when_set() {
        let mut bm = make_bookmark(8);
        bm.line_number_end = Some(20);
        bm.snippet = Some(vec!["line A".to_string(), "line B".to_string()]);
        bm.category = Some("error".to_string());
        bm.tags = Some(vec!["crash".to_string(), "oom".to_string()]);

        let json = serde_json::to_string(&bm).unwrap();
        let parsed: Bookmark = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.line_number_end, Some(20));
        assert_eq!(parsed.snippet, Some(vec!["line A".to_string(), "line B".to_string()]));
        assert_eq!(parsed.category, Some("error".to_string()));
        assert_eq!(parsed.tags, Some(vec!["crash".to_string(), "oom".to_string()]));

        let val: serde_json::Value = serde_json::to_value(&bm).unwrap();
        assert!(val.get("lineNumberEnd").is_some());
        assert!(val.get("snippet").is_some());
        assert!(val.get("category").is_some());
        assert!(val.get("tags").is_some());
    }

    #[test]
    fn new_fields_deserialize_from_json() {
        let json = r#"{
            "id": "bm-1",
            "sessionId": "sess-1",
            "lineNumber": 10,
            "lineNumberEnd": 15,
            "snippet": ["foo", "bar"],
            "category": "perf",
            "tags": ["slow", "gpu"],
            "label": "My Label",
            "note": "",
            "createdBy": "User",
            "createdAt": 999
        }"#;
        let bm: Bookmark = serde_json::from_str(json).unwrap();
        assert_eq!(bm.line_number_end, Some(15));
        assert_eq!(bm.snippet, Some(vec!["foo".to_string(), "bar".to_string()]));
        assert_eq!(bm.category, Some("perf".to_string()));
        assert_eq!(bm.tags, Some(vec!["slow".to_string(), "gpu".to_string()]));
    }
}
