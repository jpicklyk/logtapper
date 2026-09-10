//! Bookmark mutation and listing service.
//!
//! The single implementation of bookmark CRUD, shared by `commands::bookmark`
//! (`Caller::Ui`) and `mcp_bridge::routes::artifacts` (`Caller::Agent`).
//! Before this package existed the two transports each hand-rolled the same
//! lock + mutate + emit + autosave sequence against `AppState::bookmarks`,
//! with the bridge additionally re-implementing the category/tag list filter.
//!
//! Every mutation: locks `AppState::bookmarks`, mutates, drops the guard,
//! emits the identical `bookmark-update` event both transports' UI listeners
//! already expect, schedules an autosave flush, and journals the action so it
//! shows up in the activity feed regardless of which caller performed it.

use uuid::Uuid;

use crate::core::bookmark::{Bookmark, BookmarkUpdateEvent, CreatedBy};
use crate::workspace::autosave::schedule_autosave;

use super::{lock_svc, ServiceCtx, ServiceError};

/// Create a bookmark, emit `bookmark-update` (`created`), schedule an
/// autosave flush, and journal `bookmark.create`.
#[allow(clippy::too_many_arguments)]
pub fn create(
    ctx: &ServiceCtx,
    session_id: String,
    line_number: u32,
    label: String,
    note: String,
    created_by: CreatedBy,
    line_number_end: Option<u32>,
    snippet: Option<Vec<String>>,
    category: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Bookmark, ServiceError> {
    {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        if !sessions.contains_key(&session_id) {
            return Err(ServiceError::NotFound(format!(
                "Session not found: {session_id}"
            )));
        }
    }

    let bookmark = Bookmark {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.clone(),
        line_number,
        line_number_end,
        snippet,
        category,
        tags,
        label,
        note,
        created_by,
        created_at: crate::workspace::now_ms(),
    };

    {
        let mut bookmarks = lock_svc(&ctx.state().bookmarks, "bookmarks")?;
        bookmarks
            .entry(session_id.clone())
            .or_default()
            .push(bookmark.clone());
    }

    ctx.events().emit_json(
        "bookmark-update",
        serde_json::to_value(BookmarkUpdateEvent {
            session_id: session_id.clone(),
            action: "created".to_string(),
            bookmark: bookmark.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "bookmark.create",
        Some(&session_id),
        format!("line {}: {}", bookmark.line_number, bookmark.label),
    );

    Ok(bookmark)
}

/// Update a bookmark's label / note / category / tags, emit `bookmark-update`
/// (`updated`), schedule an autosave flush, and journal `bookmark.update`.
pub fn update(
    ctx: &ServiceCtx,
    session_id: String,
    bookmark_id: String,
    label: Option<String>,
    note: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Bookmark, ServiceError> {
    let updated = {
        let mut bookmarks = lock_svc(&ctx.state().bookmarks, "bookmarks")?;
        let list = bookmarks.get_mut(&session_id).ok_or_else(|| {
            ServiceError::NotFound(format!("No bookmarks for session: {session_id}"))
        })?;

        let bm = list
            .iter_mut()
            .find(|b| b.id == bookmark_id)
            .ok_or_else(|| ServiceError::NotFound(format!("Bookmark not found: {bookmark_id}")))?;

        if let Some(l) = label {
            bm.label = l;
        }
        if let Some(n) = note {
            bm.note = n;
        }
        if let Some(c) = category {
            bm.category = Some(c);
        }
        if let Some(t) = tags {
            bm.tags = Some(t);
        }

        bm.clone()
    };

    ctx.events().emit_json(
        "bookmark-update",
        serde_json::to_value(BookmarkUpdateEvent {
            session_id: session_id.clone(),
            action: "updated".to_string(),
            bookmark: updated.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "bookmark.update",
        Some(&session_id),
        format!("bookmark {bookmark_id}"),
    );

    Ok(updated)
}

/// Remove a bookmark, emit `bookmark-update` (`deleted`), schedule an
/// autosave flush, and journal `bookmark.delete`. Returns the removed
/// bookmark (the same value carried in the emitted event).
pub fn remove(
    ctx: &ServiceCtx,
    session_id: String,
    bookmark_id: String,
) -> Result<Bookmark, ServiceError> {
    let removed = {
        let mut bookmarks = lock_svc(&ctx.state().bookmarks, "bookmarks")?;
        let list = bookmarks.get_mut(&session_id).ok_or_else(|| {
            ServiceError::NotFound(format!("No bookmarks for session: {session_id}"))
        })?;

        let idx = list
            .iter()
            .position(|b| b.id == bookmark_id)
            .ok_or_else(|| ServiceError::NotFound(format!("Bookmark not found: {bookmark_id}")))?;

        list.remove(idx)
    };

    ctx.events().emit_json(
        "bookmark-update",
        serde_json::to_value(BookmarkUpdateEvent {
            session_id: session_id.clone(),
            action: "deleted".to_string(),
            bookmark: removed.clone(),
        })
        .unwrap_or_default(),
    );

    schedule_autosave(ctx.state());
    ctx.journal(
        "bookmark.delete",
        Some(&session_id),
        format!("bookmark {bookmark_id}"),
    );

    Ok(removed)
}

/// List bookmarks for a session, optionally filtered by `category` and/or
/// `tag`. Shared by the Tauri command (which passes `None, None` and so
/// always returns the full unfiltered list) and the MCP bridge's
/// `GET /mcp/sessions/{id}/bookmarks?category=&tag=` query filter.
pub fn list(
    ctx: &ServiceCtx,
    session_id: &str,
    category: Option<&str>,
    tag: Option<&str>,
) -> Result<Vec<Bookmark>, ServiceError> {
    let bookmarks = lock_svc(&ctx.state().bookmarks, "bookmarks")?;
    let list = bookmarks.get(session_id).cloned().unwrap_or_default();
    Ok(list
        .into_iter()
        .filter(|bm| {
            if let Some(cat) = category {
                if bm.category.as_deref() != Some(cat) {
                    return false;
                }
            }
            if let Some(t) = tag {
                let has_tag = bm
                    .tags
                    .as_ref()
                    .is_some_and(|tags| tags.iter().any(|x| x == t));
                if !has_tag {
                    return false;
                }
            }
            true
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;
    use crate::workspace::autosave::has_pending_flush;

    fn mk_tags(tags: &[&str]) -> Option<Vec<String>> {
        Some(tags.iter().copied().map(str::to_string).collect())
    }

    #[test]
    fn create_emits_one_event_journals_and_schedules_autosave() {
        let (ctx, sink, _tmp) = test_ctx().agent("claude-code").with_session("s1", 5).build_recording();

        let bm = create(
            &ctx,
            "s1".to_string(),
            3,
            "Label".to_string(),
            "Note".to_string(),
            CreatedBy::Agent,
            None,
            None,
            Some("crash".to_string()),
            mk_tags(&["oom"]),
        )
        .expect("create must succeed for an existing session");

        let payload = sink.only_event("bookmark-update");
        assert_eq!(payload["action"], "created");
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["bookmark"]["id"], bm.id);
        assert_eq!(payload["bookmark"]["lineNumber"], 3);

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "bookmark.create");
        assert_eq!(activity[0].session_id.as_deref(), Some("s1"));
        assert_eq!(activity[0].caller, crate::services::Caller::agent("claude-code"));

        assert!(has_pending_flush(ctx.state()), "create must schedule an autosave flush");
    }

    #[test]
    fn create_rejects_unknown_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = create(
            &ctx,
            "missing".to_string(),
            1,
            String::new(),
            String::new(),
            CreatedBy::User,
            None,
            None,
            None,
            None,
        )
        .expect_err("must fail for a session that does not exist");
        assert_eq!(err.message(), "Session not found: missing");
        assert!(matches!(err, ServiceError::NotFound(_)));
    }

    #[test]
    fn update_changes_fields_and_emits_updated_event() {
        let (ctx, sink, _tmp) = test_ctx().with_session("s1", 5).build_recording();
        let bm = create(
            &ctx,
            "s1".to_string(),
            1,
            "Old".to_string(),
            "n".to_string(),
            CreatedBy::User,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        sink.clear();

        let updated = update(
            &ctx,
            "s1".to_string(),
            bm.id,
            Some("New".to_string()),
            None,
            Some("category-a".to_string()),
            None,
        )
        .expect("update must find the bookmark just created");

        assert_eq!(updated.label, "New");
        assert_eq!(updated.category.as_deref(), Some("category-a"));
        let payload = sink.only_event("bookmark-update");
        assert_eq!(payload["action"], "updated");
    }

    #[test]
    fn update_errors_when_bookmark_not_found() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        let err = update(
            &ctx,
            "s1".to_string(),
            "no-such-id".to_string(),
            None,
            None,
            None,
            None,
        )
        .expect_err("no bookmarks exist yet for s1");
        assert_eq!(err.message(), "No bookmarks for session: s1");
    }

    #[test]
    fn remove_deletes_and_emits_deleted_event() {
        let (ctx, sink, _tmp) = test_ctx().with_session("s1", 5).build_recording();
        let bm = create(
            &ctx,
            "s1".to_string(),
            1,
            "L".to_string(),
            String::new(),
            CreatedBy::User,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        sink.clear();

        let removed = remove(&ctx, "s1".to_string(), bm.id.clone()).expect("must find and remove");
        assert_eq!(removed.id, bm.id);
        let payload = sink.only_event("bookmark-update");
        assert_eq!(payload["action"], "deleted");

        assert!(list(&ctx, "s1", None, None).unwrap().is_empty());
    }

    #[test]
    fn list_unfiltered_returns_everything() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        create(&ctx, "s1".to_string(), 1, "A".into(), String::new(), CreatedBy::User, None, None, Some("perf".into()), None).unwrap();
        create(&ctx, "s1".to_string(), 2, "B".into(), String::new(), CreatedBy::User, None, None, Some("crash".into()), mk_tags(&["oom"])).unwrap();

        let all = list(&ctx, "s1", None, None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn list_filters_by_category_and_tag() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        create(&ctx, "s1".to_string(), 1, "A".into(), String::new(), CreatedBy::User, None, None, Some("perf".into()), None).unwrap();
        create(&ctx, "s1".to_string(), 2, "B".into(), String::new(), CreatedBy::User, None, None, Some("crash".into()), mk_tags(&["oom"])).unwrap();

        let by_category = list(&ctx, "s1", Some("crash"), None).unwrap();
        assert_eq!(by_category.len(), 1);
        assert_eq!(by_category[0].label, "B");

        let by_tag = list(&ctx, "s1", None, Some("oom")).unwrap();
        assert_eq!(by_tag.len(), 1);
        assert_eq!(by_tag[0].label, "B");

        let no_match = list(&ctx, "s1", Some("nope"), None).unwrap();
        assert!(no_match.is_empty());
    }

    #[test]
    fn list_unknown_session_is_empty_not_an_error() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(list(&ctx, "no-such-session", None, None).unwrap().is_empty());
    }
}
