//! Agent navigation requests — an agent asking the UI to jump somewhere.
//!
//! `request_navigation` never applies the jump itself: it validates the
//! target session, assigns a monotonic id, journals `nav.request`, and emits
//! `navigate-request`. The frontend decides whether to apply the jump
//! immediately or hold it for the user to confirm, per its own
//! `require_nav_confirmation` setting (frontend-local for now). There is no
//! pending-request store in this phase — the emitted event IS the request;
//! nothing is left to poll for.
//!
//! Both `id` and `requested_by`/`ts` are stamped by the service — never taken
//! from the request body — so a caller cannot spoof another agent's request
//! or forge an id.

use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{lock_svc, Caller, ServiceCtx, ServiceError};

/// Caller-supplied fields for [`request_navigation`]. `id`, `requested_by`,
/// and `ts` are stamped by the service.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NavRequestInput {
    pub session_id: String,
    #[ts(type = "number | null")]
    pub line: Option<u64>,
    pub analysis_id: Option<String>,
    pub reason: String,
}

/// A single navigation request, as journaled and emitted.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NavRequest {
    #[ts(type = "number")]
    pub id: u64,
    pub session_id: String,
    #[ts(type = "number | null")]
    pub line: Option<u64>,
    pub analysis_id: Option<String>,
    pub reason: String,
    pub requested_by: Caller,
    #[ts(type = "number")]
    pub ts: u64,
}

/// Validate `input.session_id` exists, assign a fresh id from
/// `AppState::nav_request_seq`, journal `nav.request` (the summary includes
/// `reason`), and emit `navigate-request` with the full [`NavRequest`].
pub fn request_navigation(
    ctx: &ServiceCtx,
    input: NavRequestInput,
) -> Result<NavRequest, ServiceError> {
    {
        let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
        if !sessions.contains_key(&input.session_id) {
            return Err(ServiceError::session_not_found(&input.session_id));
        }
    }

    let id = ctx.state().nav_request_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let req = NavRequest {
        id,
        session_id: input.session_id,
        line: input.line,
        analysis_id: input.analysis_id,
        reason: input.reason,
        requested_by: ctx.caller().clone(),
        ts: now_millis(),
    };

    ctx.events().emit_json(
        "navigate-request",
        serde_json::to_value(&req).unwrap_or_default(),
    );

    let summary = match req.line {
        Some(line) => format!("{} (line {line})", req.reason),
        None => req.reason.clone(),
    };
    ctx.journal("nav.request", Some(&req.session_id), summary);

    Ok(req)
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

    fn input(session_id: &str) -> NavRequestInput {
        NavRequestInput {
            session_id: session_id.to_string(),
            line: Some(101),
            analysis_id: Some("a1".to_string()),
            reason: "found the crash root cause here".to_string(),
        }
    }

    #[test]
    fn request_navigation_stamps_id_caller_and_time() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").with_session("s1", 5).build();

        let req = request_navigation(&ctx, input("s1")).unwrap();
        assert_eq!(req.id, 1);
        assert_eq!(req.session_id, "s1");
        assert_eq!(req.line, Some(101));
        assert_eq!(req.analysis_id.as_deref(), Some("a1"));
        assert_eq!(req.reason, "found the crash root cause here");
        assert_eq!(req.requested_by, Caller::agent("claude-code"));
        assert!(req.ts > 0);
    }

    #[test]
    fn ids_are_monotonic_across_calls() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        let a = request_navigation(&ctx, input("s1")).unwrap();
        let b = request_navigation(&ctx, input("s1")).unwrap();
        let c = request_navigation(&ctx, input("s1")).unwrap();
        assert_eq!((a.id, b.id, c.id), (1, 2, 3));
    }

    #[test]
    fn rejects_an_unknown_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = request_navigation(&ctx, input("nosuch")).unwrap_err();
        assert_eq!(err, ServiceError::session_not_found("nosuch"));
    }

    #[test]
    fn journals_nav_request_with_the_reason_in_the_summary() {
        let (ctx, sink, _tmp) = test_ctx().agent("claude-code").with_session("s1", 5).build_recording();

        let req = request_navigation(&ctx, input("s1")).unwrap();

        let entries = ctx.state().activity.list(None, None);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].action, "nav.request");
        assert_eq!(entries[0].session_id.as_deref(), Some("s1"));
        assert!(entries[0].summary.contains("found the crash root cause here"));
        assert!(entries[0].summary.contains("101"));

        let emitted = sink.only_event("navigate-request");
        assert_eq!(emitted, serde_json::to_value(&req).unwrap());
    }

    #[test]
    fn a_failed_request_does_not_consume_an_id_or_journal() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        assert!(request_navigation(&ctx, input("nosuch")).is_err());
        assert_eq!(ctx.state().activity.list(None, None).len(), 0);

        // The next successful request still starts at 1 — a rejected request
        // never touched the sequence counter.
        let req = request_navigation(&ctx, input("s1")).unwrap();
        assert_eq!(req.id, 1);
    }

    #[test]
    fn nav_request_serializes_camel_case() {
        let req = NavRequest {
            id: 7,
            session_id: "s1".to_string(),
            line: None,
            analysis_id: None,
            reason: "check this".to_string(),
            requested_by: Caller::agent("mcp"),
            ts: 999,
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["analysisId"], serde_json::Value::Null);
        assert_eq!(v["requestedBy"]["kind"], "agent");
        assert_eq!(v["ts"], 999);
    }
}
