//! Watch mutation and listing service.
//!
//! The single implementation of watch create/list/cancel, replacing what used
//! to be two independent copies: `commands::watch` (the Tauri command path)
//! and the MCP bridge's own `routes::watches` handlers. Before this package,
//! a watch created by an agent over the bridge was invisible to the UI —
//! nothing emitted an event for it. Every mutation here — from either
//! caller — emits [`WatchUpdateEvent`] as the `watch-update` Tauri event, so
//! the Watches panel updates live regardless of which transport created or
//! cancelled the watch.
//!
//! `evaluate_watches` / `WatchLineRef` (evaluating a batch of new lines
//! against already-registered watches during ADB streaming) are unrelated to
//! this create/list/cancel surface and stay in `commands::watch`, which the
//! ADB stream loop calls directly.

use std::sync::Arc;

use serde::Serialize;
use ts_rs::TS;
use uuid::Uuid;

use crate::core::filter::FilterCriteria;
use crate::core::watch::{WatchInfo, WatchSession};

use super::{lock_svc, ServiceCtx, ServiceError};

/// Payload emitted as the `watch-update` Tauri event on every watch mutation
/// (create or cancel), from either caller. New in WP-5 — until now an
/// agent-created watch (via the MCP bridge) was invisible to the UI because
/// nothing emitted an event for it.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WatchUpdateEvent {
    pub action: String,
    pub watch: WatchInfo,
    pub session_id: String,
}

/// Create a watch on `session_id`, emit `watch-update` (`created`), and
/// journal `watch.create`. Rejects an invalid regex before the watch is
/// registered — otherwise it would sit active against every batch and never
/// match.
pub fn create(
    ctx: &ServiceCtx,
    session_id: String,
    criteria: FilterCriteria,
) -> Result<WatchInfo, ServiceError> {
    {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        if !sessions.contains_key(&session_id) {
            return Err(ServiceError::NotFound(format!(
                "Session not found: {session_id}"
            )));
        }
    }

    let watch_id = Uuid::new_v4().to_string();
    let watch = Arc::new(
        WatchSession::new(watch_id, session_id.clone(), criteria.clone())
            .map_err(ServiceError::invalid_arg)?,
    );

    let info = WatchInfo {
        watch_id: watch.watch_id.clone(),
        session_id: watch.session_id.clone(),
        total_matches: 0,
        active: true,
        criteria,
    };

    {
        let mut watches = lock_svc(&ctx.state().active_watches, "active_watches")?;
        watches.entry(session_id.clone()).or_default().push(watch);
    }

    ctx.events().emit_json(
        "watch-update",
        serde_json::to_value(WatchUpdateEvent {
            action: "created".to_string(),
            watch: info.clone(),
            session_id: session_id.clone(),
        })
        .unwrap_or_default(),
    );

    ctx.journal(
        "watch.create",
        Some(&session_id),
        format!("watch {}", info.watch_id),
    );

    Ok(info)
}

/// Cancel a watch by id, emit `watch-update` (`cancelled`), and journal
/// `watch.cancel`.
pub fn cancel(
    ctx: &ServiceCtx,
    session_id: String,
    watch_id: String,
) -> Result<(), ServiceError> {
    let info = {
        let watches = lock_svc(&ctx.state().active_watches, "active_watches")?;
        let watch = watches
            .get(&session_id)
            .and_then(|list| list.iter().find(|w| w.watch_id == watch_id))
            .ok_or_else(|| ServiceError::NotFound(format!("Watch not found: {watch_id}")))?;

        watch.cancel();

        WatchInfo {
            watch_id: watch.watch_id.clone(),
            session_id: watch.session_id.clone(),
            total_matches: watch.total_matches(),
            active: watch.is_active(),
            criteria: watch.criteria.clone(),
        }
    };

    ctx.events().emit_json(
        "watch-update",
        serde_json::to_value(WatchUpdateEvent {
            action: "cancelled".to_string(),
            watch: info,
            session_id: session_id.clone(),
        })
        .unwrap_or_default(),
    );

    ctx.journal("watch.cancel", Some(&session_id), format!("watch {watch_id}"));

    Ok(())
}

/// List all watches (active and cancelled) for a session.
pub fn list(ctx: &ServiceCtx, session_id: &str) -> Result<Vec<WatchInfo>, ServiceError> {
    let watches = lock_svc(&ctx.state().active_watches, "active_watches")?;
    let list = watches.get(session_id);
    Ok(list
        .map(|ws| {
            ws.iter()
                .map(|w| WatchInfo {
                    watch_id: w.watch_id.clone(),
                    session_id: w.session_id.clone(),
                    total_matches: w.total_matches(),
                    active: w.is_active(),
                    criteria: w.criteria.clone(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;
    use crate::services::Caller;

    fn criteria(text: &str) -> FilterCriteria {
        FilterCriteria {
            text_search: Some(text.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn create_emits_watch_update_and_journals_for_ui_caller() {
        let (ctx, sink, _tmp) = test_ctx().with_session("s1", 5).build_recording();

        let info = create(&ctx, "s1".to_string(), criteria("error"))
            .expect("create must succeed for an existing session");

        assert!(info.active);
        assert_eq!(info.total_matches, 0);

        let payload = sink.only_event("watch-update");
        assert_eq!(payload["action"], "created");
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["watch"]["watchId"], info.watch_id);

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.len(), 1);
        assert_eq!(activity[0].action, "watch.create");
        assert_eq!(activity[0].caller, Caller::Ui);
    }

    #[test]
    fn create_emits_watch_update_for_agent_caller_too() {
        // The whole point of WP-5: an agent-created watch must be just as
        // visible to the UI as one the UI created itself.
        let (ctx, sink, _tmp) = test_ctx().agent("claude-code").with_session("s1", 5).build_recording();

        let info = create(&ctx, "s1".to_string(), criteria("anr")).unwrap();

        let payload = sink.only_event("watch-update");
        assert_eq!(payload["action"], "created");
        assert_eq!(payload["watch"]["watchId"], info.watch_id);

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity[0].caller, Caller::agent("claude-code"));
    }

    #[test]
    fn create_rejects_unknown_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = create(&ctx, "missing".to_string(), criteria("x"))
            .expect_err("must fail for a session that does not exist");
        assert_eq!(err.message(), "Session not found: missing");
    }

    #[test]
    fn create_rejects_invalid_regex_without_registering_the_watch() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        let bad = FilterCriteria {
            regex: Some("[invalid".to_string()),
            ..Default::default()
        };
        let err = create(&ctx, "s1".to_string(), bad).expect_err("invalid regex must be rejected");
        assert!(err.message().contains("[invalid"));
        assert!(list(&ctx, "s1").unwrap().is_empty(), "a rejected watch must not be registered");
    }

    #[test]
    fn cancel_deactivates_and_emits_watch_update() {
        let (ctx, sink, _tmp) = test_ctx().with_session("s1", 5).build_recording();
        let info = create(&ctx, "s1".to_string(), criteria("error")).unwrap();
        sink.clear();

        cancel(&ctx, "s1".to_string(), info.watch_id).expect("must find and cancel");

        let payload = sink.only_event("watch-update");
        assert_eq!(payload["action"], "cancelled");
        assert_eq!(payload["watch"]["active"], false);

        let listed = list(&ctx, "s1").unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].active);

        let activity = ctx.state().activity.list(None, None);
        assert_eq!(activity.last().unwrap().action, "watch.cancel");
    }

    #[test]
    fn cancel_errors_when_watch_not_found() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        let err = cancel(&ctx, "s1".to_string(), "no-such-watch".to_string())
            .expect_err("must fail for an unknown watch id");
        assert_eq!(err.message(), "Watch not found: no-such-watch");
    }

    #[test]
    fn list_returns_active_and_cancelled_watches() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        let a = create(&ctx, "s1".to_string(), criteria("a")).unwrap();
        let _b = create(&ctx, "s1".to_string(), criteria("b")).unwrap();
        cancel(&ctx, "s1".to_string(), a.watch_id.clone()).unwrap();

        let listed = list(&ctx, "s1").unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|w| w.watch_id == a.watch_id && !w.active));
        assert!(listed.iter().any(|w| w.watch_id != a.watch_id && w.active));
    }

    #[test]
    fn list_unknown_session_is_empty_not_an_error() {
        let (ctx, _tmp) = test_ctx().build();
        assert!(list(&ctx, "no-such-session").unwrap().is_empty());
    }
}
