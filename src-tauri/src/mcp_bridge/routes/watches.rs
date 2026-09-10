//! Watch endpoints: list, create, cancel.

use axum::{
    Json,
    extract::{Path, State},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::mcp_bridge::BridgeCtx;
use crate::mcp_bridge::respond::verify_session_exists;

pub(crate) async fn h_list_watches(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
) -> Json<Value> {
    let state = &*ctx.state;
    let watches = state.active_watches.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let list = watches.get(&session_id);
    let infos: Vec<Value> = list
        .map(|ws| {
            ws.iter()
                .map(|w| {
                    json!({
                        "watchId": w.watch_id,
                        "sessionId": w.session_id,
                        "totalMatches": w.total_matches(),
                        "active": w.is_active(),
                        "criteria": serde_json::to_value(&w.criteria).unwrap_or(json!(null)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Json(json!(infos))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateWatchBody {
    #[serde(flatten)]
    criteria: crate::core::filter::FilterCriteria,
}

pub(crate) async fn h_create_watch(
    State(ctx): State<BridgeCtx>,
    Path(session_id): Path<String>,
    Json(body): Json<CreateWatchBody>,
) -> Json<Value> {
    use std::sync::Arc;
    use crate::core::watch::{WatchSession, WatchInfo};

    let state = &*ctx.state;

    verify_session_exists!(state, session_id);

    let watch_id = uuid::Uuid::new_v4().to_string();
    let watch = match WatchSession::new(watch_id, session_id.clone(), body.criteria.clone()) {
        Ok(w) => Arc::new(w),
        Err(e) => return Json(json!({ "error": e })),
    };

    let info = WatchInfo {
        watch_id: watch.watch_id.clone(),
        session_id: watch.session_id.clone(),
        total_matches: 0,
        active: true,
        criteria: body.criteria,
    };

    {
        let mut watches = state.active_watches.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        watches
            .entry(session_id)
            .or_default()
            .push(watch);
    }

    Json(json!(info))
}

pub(crate) async fn h_cancel_watch(
    State(ctx): State<BridgeCtx>,
    Path((session_id, watch_id)): Path<(String, String)>,
) -> Json<Value> {
    let state = &*ctx.state;
    let watches = state.active_watches.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(list) = watches.get(&session_id) {
        if let Some(w) = list.iter().find(|w| w.watch_id == watch_id) {
            w.cancel();
            return Json(json!({"ok": true}));
        }
    }
    Json(json!({"error": format!("Watch not found: {watch_id}")}))
}
