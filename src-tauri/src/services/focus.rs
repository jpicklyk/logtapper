//! Shared focus context — an explicit "ask about this" handoff between the UI
//! and an agent.
//!
//! Distinct from `AppState::focused_session` (which pane's session the UI
//! currently has open, used to disambiguate same-named sessions over the MCP
//! bridge). This is a narrower, explicit signal: a session plus an optional
//! line/section/selection/note, stamped with who set it and when — either
//! caller may set or clear it, and either caller may read it. There is
//! exactly one focus context at a time (not per-session, not per-pane); a new
//! `set_focus` call replaces whatever was there.
//!
//! Both `set_by` and `ts` are stamped by the service from `ctx.caller()` and
//! the current time — never taken from the request body — so a caller cannot
//! spoof who set focus or backdate it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{lock_svc, Caller, ServiceCtx, ServiceError};

/// An inclusive line range, e.g. a text selection in the log viewer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    #[ts(type = "number")]
    pub start: u64,
    #[ts(type = "number")]
    pub end: u64,
}

/// Caller-supplied fields for [`set_focus`]. `set_by` and `ts` are not part of
/// the input — the service stamps both from [`ServiceCtx`] itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FocusContextInput {
    pub session_id: String,
    #[ts(type = "number | null")]
    pub line: Option<u64>,
    pub section: Option<String>,
    pub selection: Option<LineRange>,
    pub note: Option<String>,
}

/// The shared focus context as stored and returned: [`FocusContextInput`]'s
/// fields plus who set it and when.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FocusContext {
    pub session_id: String,
    #[ts(type = "number | null")]
    pub line: Option<u64>,
    pub section: Option<String>,
    pub selection: Option<LineRange>,
    pub note: Option<String>,
    pub set_by: Caller,
    #[ts(type = "number")]
    pub ts: u64,
}

/// Set (`Some`) or clear (`None`) the shared focus context.
///
/// Setting validates that `input.session_id` names a session that exists
/// (`ServiceError::NotFound` otherwise) — a focus context pointing at a
/// session nobody can open is useless to whoever reads it next. Either
/// outcome journals (`focus.set` / `focus.clear`) and emits `focus-changed`
/// with the new value (or `null` when cleared), so a UI listener and a
/// polling agent both see the same change.
pub fn set_focus(
    ctx: &ServiceCtx,
    input: Option<FocusContextInput>,
) -> Result<Option<FocusContext>, ServiceError> {
    match input {
        Some(input) => {
            {
                let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
                if !sessions.contains_key(&input.session_id) {
                    return Err(ServiceError::session_not_found(&input.session_id));
                }
            }

            let context = FocusContext {
                session_id: input.session_id,
                line: input.line,
                section: input.section,
                selection: input.selection,
                note: input.note,
                set_by: ctx.caller().clone(),
                ts: now_millis(),
            };

            {
                let mut focus = lock_svc(&ctx.state().focus, "focus")?;
                *focus = Some(context.clone());
            }

            ctx.events().emit_json(
                "focus-changed",
                serde_json::to_value(&context).unwrap_or_default(),
            );

            let summary = match (&context.line, &context.note) {
                (Some(line), Some(note)) => format!("line {line}: {note}"),
                (Some(line), None) => format!("line {line}"),
                (None, Some(note)) => note.clone(),
                (None, None) => "session".to_string(),
            };
            ctx.journal("focus.set", Some(&context.session_id), summary);

            Ok(Some(context))
        }
        None => {
            let previous = {
                let mut focus = lock_svc(&ctx.state().focus, "focus")?;
                focus.take()
            };

            ctx.events().emit_json("focus-changed", serde_json::Value::Null);

            ctx.journal(
                "focus.clear",
                previous.as_ref().map(|f| f.session_id.as_str()),
                "cleared",
            );

            Ok(None)
        }
    }
}

/// Read the current focus context, or `None` when nothing is focused.
pub fn get_focus(ctx: &ServiceCtx) -> Result<Option<FocusContext>, ServiceError> {
    let focus = lock_svc(&ctx.state().focus, "focus")?;
    Ok(focus.clone())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;

    fn input(session_id: &str) -> FocusContextInput {
        FocusContextInput {
            session_id: session_id.to_string(),
            line: Some(42),
            section: Some("boot".to_string()),
            selection: Some(LineRange { start: 40, end: 44 }),
            note: Some("check this ANR".to_string()),
        }
    }

    #[test]
    fn get_focus_starts_empty() {
        let (ctx, _tmp) = test_ctx().build();
        assert_eq!(get_focus(&ctx).unwrap(), None);
    }

    #[test]
    fn set_focus_stores_and_returns_the_stamped_context() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").with_session("s1", 5).build();

        let stored = set_focus(&ctx, Some(input("s1"))).unwrap().expect("Some");
        assert_eq!(stored.session_id, "s1");
        assert_eq!(stored.line, Some(42));
        assert_eq!(stored.section.as_deref(), Some("boot"));
        assert_eq!(stored.selection, Some(LineRange { start: 40, end: 44 }));
        assert_eq!(stored.note.as_deref(), Some("check this ANR"));
        assert_eq!(stored.set_by, Caller::agent("claude-code"));
        assert!(stored.ts > 0);

        assert_eq!(get_focus(&ctx).unwrap(), Some(stored));
    }

    #[test]
    fn set_focus_rejects_an_unknown_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = set_focus(&ctx, Some(input("nosuch"))).unwrap_err();
        assert_eq!(err, ServiceError::session_not_found("nosuch"));
        assert_eq!(get_focus(&ctx).unwrap(), None, "a rejected set must not partially apply");
    }

    #[test]
    fn set_focus_none_clears_a_previously_set_context() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        set_focus(&ctx, Some(input("s1"))).unwrap();
        assert!(get_focus(&ctx).unwrap().is_some());

        let cleared = set_focus(&ctx, None).unwrap();
        assert_eq!(cleared, None);
        assert_eq!(get_focus(&ctx).unwrap(), None);
    }

    #[test]
    fn a_new_set_focus_replaces_the_previous_one() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).with_session("s2", 5).build();
        set_focus(&ctx, Some(input("s1"))).unwrap();
        let second = set_focus(&ctx, Some(input("s2"))).unwrap().unwrap();
        assert_eq!(get_focus(&ctx).unwrap(), Some(second));
    }

    #[test]
    fn set_focus_journals_and_emits_focus_changed() {
        let (ctx, sink, _tmp) = test_ctx().agent("claude-code").with_session("s1", 5).build_recording();

        let stored = set_focus(&ctx, Some(input("s1"))).unwrap().unwrap();

        let entries = ctx.state().activity.list(None, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].action, "focus.set");
        assert_eq!(entries[0].session_id.as_deref(), Some("s1"));
        assert_eq!(entries[0].caller, Caller::agent("claude-code"));

        let emitted = sink.only_event("focus-changed");
        assert_eq!(emitted, serde_json::to_value(&stored).unwrap());
    }

    #[test]
    fn clear_journals_and_emits_null() {
        let (ctx, sink, _tmp) = test_ctx().with_session("s1", 5).build_recording();
        set_focus(&ctx, Some(input("s1"))).unwrap();
        sink.clear();

        let cleared = set_focus(&ctx, None).unwrap();
        assert_eq!(cleared, None);

        // The earlier `set_focus` already journaled `focus.set`; only the
        // journal is unaffected by `sink.clear()` (which only forgets
        // recorded *emissions*), so the clear's entry is the second one.
        let entries = ctx.state().activity.list(None, None);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].action, "focus.clear");
        assert_eq!(entries[1].session_id.as_deref(), Some("s1"));

        let emitted = sink.only_event("focus-changed");
        assert_eq!(emitted, serde_json::Value::Null);
    }

    #[test]
    fn clearing_with_nothing_set_still_journals_with_no_session() {
        let (ctx, _tmp) = test_ctx().build();
        set_focus(&ctx, None).unwrap();
        let entries = ctx.state().activity.list(None, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].action, "focus.clear");
        assert_eq!(entries[0].session_id, None);
    }

    #[test]
    fn focus_context_serializes_camel_case() {
        let context = FocusContext {
            session_id: "s1".to_string(),
            line: Some(3),
            section: None,
            selection: None,
            note: None,
            set_by: Caller::Ui,
            ts: 123,
        };
        let v = serde_json::to_value(&context).unwrap();
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["line"], 3);
        assert_eq!(v["setBy"]["kind"], "ui");
        assert_eq!(v["ts"], 123);
    }
}
