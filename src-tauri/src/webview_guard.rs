//! Webview navigation policy — the backend half of "external links must not
//! hijack the window".
//!
//! The `main` window has no browser chrome: `run()`'s `setup` strips the native
//! title bar (macOS gets an overlay), and the frontend draws its own. So a
//! navigation away from the app's own origin replaces the *entire* UI with a
//! remote page and leaves no back affordance — the only recovery is to kill the
//! process. Markdown prose rendered by the analyses reader and the editor
//! preview can contain arbitrary `http`/`https`/`mailto` links, and an MCP agent
//! can publish such an analysis through the bridge (`publish_analysis`), so
//! "the link was authored by the person at the keyboard" is not an assumption
//! this app gets to make.
//!
//! [`plugin()`] installs [`is_app_navigation`] as a plugin `on_navigation` hook.
//! That hook — not `tauri::Builder`, which has none — is what covers a window
//! declared in `tauri.conf.json`: `manager::webview` consults the plugin store
//! for every webview's navigation handler. Returning `false` cancels the
//! navigation.
//!
//! This is defence in depth, not the primary mechanism. The renderers intercept
//! the click first and hand the URL to `tauri-plugin-opener`
//! (`src-next/bridge/externalLinks.ts`), so reaching a denial here means
//! something got past the frontend — hence the `warn!`.

use tauri::Url;

/// Hosts the bundled frontend is served from in a production build.
///
/// Windows' WebView2 serves the custom protocol as `http://tauri.localhost`
/// (`https://` when `app.windows[].useHttpsScheme` is set); macOS and Linux use
/// the `tauri:` scheme instead, which [`is_app_navigation`] accepts wholesale.
const PROD_APP_HOST: &str = "tauri.localhost";

/// Loopback hosts the Vite dev servers bind to (React 1420 / Solid 1421, plus
/// the `--config` bench overlays). Accepted in debug builds only — see
/// [`is_app_navigation_with`].
const DEV_APP_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Whether the webview may follow `url` itself.
///
/// `dev` is `cfg!(debug_assertions)` in the real hook; it is a parameter so both
/// branches are reachable from a (necessarily debug-built) unit test.
///
/// Deliberately a pure function of the *target* URL, with no reference to the
/// webview's current location: the very first navigation of the app's own load
/// happens before the webview is registered in the manager's map, so there is no
/// "current origin" to compare against at the moment it matters most. An
/// allow-list of app origins gets the same answer without that ordering hazard,
/// and it cannot be widened by a page that has already been navigated somewhere
/// unexpected.
pub fn is_app_navigation_with(url: &Url, dev: bool) -> bool {
    match url.scheme() {
        // `tauri:` — the production custom protocol on macOS/Linux
        // (`tauri://localhost/index.html`).
        // `about:` — `about:blank` / `about:srcdoc`, documents the webview
        // creates for itself. Never remote, and blocking them breaks the
        // webview's own bookkeeping rather than protecting anything.
        "tauri" | "about" => true,
        // `host_str()` is already lowercased and punycoded by the url crate for
        // these two special schemes, so a plain comparison is exact.
        "http" | "https" => match url.host_str() {
            Some(host) => host == PROD_APP_HOST || (dev && DEV_APP_HOSTS.contains(&host)),
            None => false,
        },
        // Everything else — `mailto:`, `file:`, `javascript:`, `data:`, a custom
        // app scheme someone registered — is not a page this app renders.
        _ => false,
    }
}

/// [`is_app_navigation_with`] with the build's own dev/prod answer.
pub fn is_app_navigation(url: &Url) -> bool {
    is_app_navigation_with(url, cfg!(debug_assertions))
}

/// The plugin that enforces [`is_app_navigation`] on every webview.
///
/// Registered in `run()` before the window is created. It declares no commands,
/// so it needs no entry in `capabilities/default.json`.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("lt-navigation-guard")
        .on_navigation(|_webview, url| {
            if is_app_navigation(url) {
                return true;
            }
            // Scheme + host only: a blocked URL's path and query are attacker- or
            // agent-supplied text that has no business in the log file.
            log::warn!(
                "[navigation] blocked webview navigation to {}://{}",
                url.scheme(),
                url.host_str().unwrap_or("<no host>")
            );
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allows(raw: &str, dev: bool) -> bool {
        is_app_navigation_with(&Url::parse(raw).expect("test URL parses"), dev)
    }

    #[test]
    fn allows_the_production_origins() {
        // macOS / Linux custom protocol, and the initial load path under it.
        assert!(allows("tauri://localhost", false));
        assert!(allows("tauri://localhost/index.html", false));
        // Windows WebView2, both scheme variants.
        assert!(allows("http://tauri.localhost/index.html", false));
        assert!(allows("https://tauri.localhost/index.html", false));
    }

    #[test]
    fn allows_reloads_hash_changes_and_the_bench_query_in_production() {
        // A reload is the same URL again; a hash change and `?bench=1` differ
        // only in the parts after the origin. None of them may be blocked.
        assert!(allows("http://tauri.localhost/index.html", false));
        assert!(allows("http://tauri.localhost/index.html#/analyses", false));
        assert!(allows("http://tauri.localhost/index.html?bench=1", false));
        assert!(allows("tauri://localhost/index.html?bench=1#section-3", false));
    }

    #[test]
    fn allows_the_vite_dev_servers_and_bench_overlays_in_dev_only() {
        for raw in [
            "http://localhost:1420/",           // React dev server
            "http://localhost:1421/?bench=1",   // Solid dev server, bench mode
            "http://127.0.0.1:1420/index.html", // same server by address
            "http://[::1]:1421/",               // and over IPv6 loopback
        ] {
            assert!(allows(raw, true), "dev build should allow {raw}");
            assert!(!allows(raw, false), "release build should refuse {raw}");
        }
    }

    #[test]
    fn blocks_remote_pages() {
        for raw in [
            "https://example.com/",
            "http://example.com/docs",
            // Look-alikes: a subdomain of the app host, and the app host as a
            // *path* or userinfo on someone else's origin.
            "https://evil.tauri.localhost/",
            "https://evil.com/tauri.localhost",
            "https://tauri.localhost.evil.com/",
        ] {
            assert!(!allows(raw, true), "should block {raw}");
            assert!(!allows(raw, false), "should block {raw}");
        }
    }

    #[test]
    fn blocks_non_page_schemes_the_opener_handles_instead() {
        // `mailto:` is opened by the OS handler via tauri-plugin-opener; the
        // webview itself must never try to "navigate" to one.
        assert!(!allows("mailto:someone@example.com", true));
        assert!(!allows("file:///C:/Windows/System32/drivers/etc/hosts", true));
        assert!(!allows("data:text/html,<h1>hi</h1>", true));
        assert!(!allows("javascript:alert(1)", true));
    }

    #[test]
    fn allows_the_webviews_own_about_documents() {
        assert!(allows("about:blank", false));
        assert!(allows("about:srcdoc", false));
    }
}
