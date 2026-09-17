//! Bridge-wide Axum middleware: trusted-origin gating, activity stamping and
//! the request-lifecycle event that drives the presence orb.

use std::sync::atomic::{AtomicU64, Ordering};

use axum::{extract::MatchedPath, extract::State, http::Method, middleware, response::IntoResponse};

use super::respond::client_name;
use super::BridgeCtx;
use crate::services::events::{
    AgentRequestEvent, AgentRequestKind, AgentRequestPhase, AGENT_REQUEST_EVENT,
};
use crate::services::ServiceError;

/// Sequence for [`AgentRequestEvent::id`]. Process-global: the `start` and
/// `end` of one request share the value, and no two requests ever do.
static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// Classify an accepted request for the presence orb, or `None` for traffic
/// that must not count as agent activity.
///
/// The one exclusion is the sidecar's heartbeat: `mcp-server/src/index.ts`
/// polls `GET /mcp/status` every 10 s for as long as the process lives, so
/// counting it would make an attached-but-idle agent look busy forever. It
/// still stamps `mcp_last_activity` — that is exactly what the heartbeat is
/// for — it just emits no event.
///
/// `route` is the matched template (`/mcp/sessions/{session_id}/query`), so
/// the long-running set below is matched exactly against `ROUTES` entries —
/// when you append a long-running route to `ROUTES`, add it here too, or it
/// will read as a brief `Write` and the orb will not show `running` for it.
pub(super) fn classify_request(method: &Method, route: &str) -> Option<AgentRequestKind> {
    const LONG_RUNNING_POSTS: &[&str] = &[
        "/mcp/sessions/{session_id}/run_pipeline",
        "/mcp/sessions/{session_id}/filters",
        "/mcp/export",
        "/mcp/adb/stream",
    ];
    if *method == Method::GET {
        return if route == "/mcp/status" { None } else { Some(AgentRequestKind::Read) };
    }
    let long_running = *method == Method::POST && LONG_RUNNING_POSTS.contains(&route);
    Some(if long_running { AgentRequestKind::Run } else { AgentRequestKind::Write })
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Middleware: stamp `mcp_last_activity` on every inbound request, and emit
/// an [`AgentRequestEvent`] pair (`start` before the handler, `end` after)
/// for every request that [`classify_request`] counts as agent activity.
///
/// Runs INSIDE [`require_local`] (see `super::router()`), so a rejected
/// request neither stamps nor emits. A request that matches no route has no
/// `MatchedPath` and emits nothing either — a 404 is not agent work.
pub(super) async fn record_activity(
    State(ctx): State<BridgeCtx>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    if let Ok(mut ts) = ctx.state.mcp_last_activity.lock() {
        *ts = Some(std::time::Instant::now());
    }

    let classified = req
        .extensions()
        .get::<MatchedPath>()
        .map(|m| m.as_str().to_owned())
        .and_then(|route| classify_request(req.method(), &route).map(|kind| (route, kind)));
    let Some((route, kind)) = classified else {
        return next.run(req).await;
    };

    let mut event = AgentRequestEvent {
        id: REQUEST_SEQ.fetch_add(1, Ordering::Relaxed) + 1,
        ts: now_millis(),
        client: client_name(req.headers()).to_owned(),
        method: req.method().as_str().to_owned(),
        route,
        kind,
        phase: AgentRequestPhase::Start,
        status: None,
    };
    ctx.events
        .emit_json(AGENT_REQUEST_EVENT, serde_json::to_value(&event).unwrap_or_default());

    let response = next.run(req).await;

    event.ts = now_millis();
    event.phase = AgentRequestPhase::End;
    event.status = Some(response.status().as_u16());
    ctx.events
        .emit_json(AGENT_REQUEST_EVENT, serde_json::to_value(&event).unwrap_or_default());
    response
}

/// Pure decision function: is this request trustworthy as a local, non-browser
/// caller of the MCP bridge? Used by [`require_local`] and unit-tested directly.
///
/// Three independent checks, any failure rejects:
/// - **Host** must be exactly `127.0.0.1:40404` or `localhost:40404`
///   (case-insensitive). A DNS-rebinding attacker's page is served from an
///   attacker-controlled domain that resolves to 127.0.0.1 *after* the
///   browser's same-origin check passes, but the HTTP `Host` header still
///   carries that attacker domain — rejecting anything but the bridge's own
///   host:port defeats the rebind regardless of what IP the request lands on.
/// - **Origin** must be absent. The MCP server's Node `fetch()` never sets
///   Origin (no browser fetch semantics); browsers add it automatically on
///   cross-origin requests (and on many same-origin ones), so any Origin at
///   all is a signal the caller is a browser, not the trusted Node client.
/// - **Referer**, if present, must start with the bridge's own origin. The
///   trusted client never sends Referer; a browser-issued CSRF request
///   typically carries the attacker page's URL here.
fn is_trusted_request(headers: &axum::http::HeaderMap) -> bool {
    const HOST_127: &str = "127.0.0.1:40404";
    const HOST_LOCALHOST: &str = "localhost:40404";
    const REFERER_127: &str = "http://127.0.0.1:40404";
    const REFERER_LOCALHOST: &str = "http://localhost:40404";
    const REFERER_127_SLASH: &str = "http://127.0.0.1:40404/";
    const REFERER_LOCALHOST_SLASH: &str = "http://localhost:40404/";

    // Host: required, must match exactly (case-insensitive).
    let host_ok = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| {
            let h = h.to_ascii_lowercase();
            h == HOST_127 || h == HOST_LOCALHOST
        });
    if !host_ok {
        return false;
    }

    // Origin: must be absent entirely.
    if headers.contains_key(axum::http::header::ORIGIN) {
        return false;
    }

    // Referer: if present, must be the bridge's own origin, matched with an
    // exact end-of-string or `/` boundary — NOT a bare prefix. A plain
    // `starts_with(origin)` would accept `http://127.0.0.1:40404.evil.com/x`
    // and `http://127.0.0.1:40404@evil.com/x`, both of which target a
    // different host despite sharing the origin as a string prefix.
    if let Some(referer) = headers.get(axum::http::header::REFERER).and_then(|v| v.to_str().ok()) {
        let referer_ok = referer == REFERER_127
            || referer == REFERER_LOCALHOST
            || referer.starts_with(REFERER_127_SLASH)
            || referer.starts_with(REFERER_LOCALHOST_SLASH);
        if !referer_ok {
            return false;
        }
    }

    true
}

/// Middleware: reject any request that does not look like it came from the
/// trusted local MCP server process. See [`is_trusted_request`] for the
/// decision logic. Runs BEFORE [`record_activity`] in the layer stack (see
/// `super::start()`) so rejected requests never stamp `mcp_last_activity`.
///
/// The refusal is still a `403`, but it now carries the same
/// `{ "error": { "code": "NOT_ALLOWED", "message": … } }` envelope every other
/// bridge failure does (it used to be a bare, empty-bodied 403). The message is
/// deliberately generic: telling a browser-origin caller *which* of the three
/// checks it tripped is a hint it has no business having.
pub(super) async fn require_local(
    State(_ctx): State<BridgeCtx>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    if !is_trusted_request(req.headers()) {
        return ServiceError::not_allowed(
            "request did not come from a trusted local MCP client",
        )
        .into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_trusted_request ───────────────────────────────────────────────────

    fn headers_from(pairs: &[(&str, &str)]) -> axum::http::HeaderMap {
        let mut headers = axum::http::HeaderMap::new();
        for (k, v) in pairs {
            headers.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        headers
    }

    #[test]
    fn trusted_host_127_no_origin() {
        let headers = headers_from(&[("host", "127.0.0.1:40404")]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn trusted_host_localhost() {
        let headers = headers_from(&[("host", "localhost:40404")]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn trusted_host_localhost_uppercase() {
        let headers = headers_from(&[("host", "LOCALHOST:40404")]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn rejects_dns_rebinding_host() {
        let headers = headers_from(&[("host", "evil.com:40404")]);
        assert!(!is_trusted_request(&headers));
    }

    #[test]
    fn rejects_missing_host() {
        let headers = headers_from(&[]);
        assert!(!is_trusted_request(&headers));
    }

    // ── classify_request ─────────────────────────────────────────────────────

    #[test]
    fn heartbeat_is_not_agent_activity() {
        assert_eq!(classify_request(&Method::GET, "/mcp/status"), None);
    }

    #[test]
    fn every_other_get_is_a_read() {
        for route in ["/mcp/sessions", "/mcp/sessions/{session_id}/query", "/mcp/activity", "/mcp/filters/{filter_id}"] {
            assert_eq!(classify_request(&Method::GET, route), Some(AgentRequestKind::Read), "{route}");
        }
    }

    #[test]
    fn long_running_posts_are_runs() {
        for route in [
            "/mcp/sessions/{session_id}/run_pipeline",
            "/mcp/sessions/{session_id}/filters",
            "/mcp/export",
            "/mcp/adb/stream",
        ] {
            assert_eq!(classify_request(&Method::POST, route), Some(AgentRequestKind::Run), "{route}");
        }
    }

    #[test]
    fn other_mutations_are_writes() {
        assert_eq!(classify_request(&Method::POST, "/mcp/sessions/{session_id}/bookmarks"), Some(AgentRequestKind::Write));
        assert_eq!(classify_request(&Method::PUT, "/mcp/focus"), Some(AgentRequestKind::Write));
        assert_eq!(classify_request(&Method::DELETE, "/mcp/filters/{filter_id}"), Some(AgentRequestKind::Write));
        // Cancelling a filter is a POST under /filters/… but not the scan itself.
        assert_eq!(classify_request(&Method::POST, "/mcp/filters/{filter_id}/cancel"), Some(AgentRequestKind::Write));
        // Exact match, not suffix: a sibling route sharing a suffix is not a run.
        assert_eq!(classify_request(&Method::POST, "/mcp/sessions/{session_id}/export_filters"), Some(AgentRequestKind::Write));
    }

    #[test]
    fn rejects_any_origin_even_with_good_host() {
        let headers = headers_from(&[
            ("host", "127.0.0.1:40404"),
            ("origin", "http://evil.com"),
        ]);
        assert!(!is_trusted_request(&headers));
    }

    #[test]
    fn rejects_foreign_referer_even_with_good_host() {
        let headers = headers_from(&[
            ("host", "127.0.0.1:40404"),
            ("referer", "http://evil.com/x"),
        ]);
        assert!(!is_trusted_request(&headers));
    }

    #[test]
    fn trusted_referer_matching_bridge_origin() {
        let headers = headers_from(&[
            ("host", "127.0.0.1:40404"),
            ("referer", "http://127.0.0.1:40404/x"),
        ]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn trusted_referer_bare_origin_no_path() {
        // Exact origin with no trailing path is a legitimate Referer.
        let headers = headers_from(&[
            ("host", "127.0.0.1:40404"),
            ("referer", "http://127.0.0.1:40404"),
        ]);
        assert!(is_trusted_request(&headers));
    }

    #[test]
    fn rejects_referer_with_suffixed_host_boundary_bypass() {
        // A bare starts_with(origin) check would accept these — the bridge
        // origin is only a string prefix; the real host is different. The
        // boundary-correct check (exact, or origin + '/') must reject them.
        for bad in [
            "http://127.0.0.1:40404.evil.com/x",
            "http://127.0.0.1:40404@evil.com/x",
            "http://localhost:40404.evil.com/x",
        ] {
            let headers = headers_from(&[("host", "127.0.0.1:40404"), ("referer", bad)]);
            assert!(!is_trusted_request(&headers), "referer {bad:?} must be rejected");
        }
    }
}
