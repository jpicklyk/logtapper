//! Bridge-wide Axum middleware: trusted-origin gating and activity stamping.

use axum::{extract::State, middleware, response::IntoResponse};

use super::BridgeCtx;
use crate::services::ServiceError;

/// Middleware: stamp `mcp_last_activity` on every inbound request.
pub(super) async fn record_activity(
    State(ctx): State<BridgeCtx>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> axum::response::Response {
    if let Ok(mut ts) = ctx.state.mcp_last_activity.lock() {
        *ts = Some(std::time::Instant::now());
    }
    next.run(req).await
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
