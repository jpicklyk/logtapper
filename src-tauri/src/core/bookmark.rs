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
}
