//! The service layer — the only implementation of LogTapper's capabilities.
//!
//! LogTapper has two clients over one backend: the React UI over Tauri
//! commands, and AI agents over the MCP HTTP bridge. Before this layer existed
//! they were two hand-maintained implementations of the same features, which
//! had already drifted (different response shapes for the same data, a
//! snapshot-mode state bug the bridge had and the commands did not, agent
//! writes the UI never saw). Everything either transport can do lives here
//! once; `commands/*` and `mcp_bridge` are thin adapters that build a
//! [`ServiceCtx`], call one service function, and marshal one
//! `Result<T, ServiceError>`.
//!
//! ## The one hard rule
//!
//! **No `use tauri` anywhere under `services/`.** Pinned by
//! [`tests::services_module_never_imports_tauri`] below, which reads this
//! directory at test time. Tauri-side implementations of the traits in
//! [`events`] and [`paths`] live in `commands/adapters.rs`.
//!
//! ## Lock discipline
//!
//! A service function holds **at most one** `AppState` lock, never across an
//! `.await`. Anything needing two goes through [`snapshot`]. Use [`lock_svc`]
//! (which produces `ServiceError::LockPoisoned`) rather than
//! `commands::lock_or_err` (which produces a `String`) — the messages are
//! identical, the error types are not.
//!
//! ## Caller identity
//!
//! Every service knows who is calling via [`Caller`]. It is set in exactly two
//! places: `commands::adapters::ui_ctx` ([`Caller::Ui`]) and
//! `mcp_bridge::BridgeCtx::svc` ([`Caller::Agent`]). [`policy`] is where that
//! identity turns into a decision — never in an individual service.

use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::commands::AppState;
use ts_rs::TS;

pub mod activity;
pub mod error;
pub mod events;
pub mod paths;
pub mod policy;
pub mod snapshot;
pub mod wire;

// Domain services — one file per package (stubs until the owning package lands).
pub mod analyses;
pub mod bookmarks;
pub mod chain;
pub mod correlator;
pub mod export;
pub mod filters;
pub mod insights;
pub mod lines;
pub mod marketplace;
pub mod pipeline;
pub mod processors;
pub mod search;
pub mod sections;
pub mod sessions;
pub mod settings;
pub mod stream;
pub mod timeline;
pub mod tracker;
pub mod watches;
pub mod workspace;
pub mod focus;
pub mod navigation;
pub mod themes;

#[cfg(any(test, feature = "test-support"))]
pub mod testing;

pub use activity::{ActivityEntry, ActivityJournal};
pub use error::ServiceError;
pub use events::{EventSink, NullProgressSink, NullSink, ProgressEvent, ProgressSink, RingSink, Sink};
pub use paths::{AppPaths, Spawner};
pub use wire::{LinePage, LineStrategy, Page, PipelineRunResult, Sampled, Truncated};

// ---------------------------------------------------------------------------
// Caller
// ---------------------------------------------------------------------------

/// Who is driving a service call.
///
/// Not a permission level — a *identity*. [`policy`] maps it to permissions, so
/// there is exactly one place to read when asking "what may an agent do?".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Caller {
    /// The desktop UI, driven by the human at the keyboard.
    Ui,
    /// An AI agent over the MCP bridge. `client` is the self-reported client
    /// name (`X-LogTapper-Client` header, defaulting to `"mcp"`) — useful for
    /// the activity feed, never trusted for authorization.
    Agent { client: String },
}

impl Caller {
    /// The default agent identity when a client sends no `X-LogTapper-Client`.
    pub fn agent(client: impl Into<String>) -> Self {
        Caller::Agent {
            client: client.into(),
        }
    }

    /// True for [`Caller::Agent`]. Prefer matching explicitly in [`policy`];
    /// this is for logging and journaling.
    pub fn is_agent(&self) -> bool {
        matches!(self, Caller::Agent { .. })
    }

    /// Short label for the activity feed and logs.
    pub fn label(&self) -> &str {
        match self {
            Caller::Ui => "ui",
            Caller::Agent { client } => client,
        }
    }
}

// ---------------------------------------------------------------------------
// lock_svc
// ---------------------------------------------------------------------------

/// Acquire an `AppState` mutex, mapping poison to [`ServiceError::LockPoisoned`].
///
/// The `ServiceError` twin of `commands::lock_or_err`. Both render the same
/// `"{name} lock poisoned"` message, so which one a code path used is invisible
/// to the user; the difference is that this one carries a status code and a
/// machine-readable `LOCK_POISONED` for the HTTP path.
///
/// `name` is `&'static str` because it names a field of `AppState`, not
/// caller-supplied data — which lets the error be `Clone`/`PartialEq` without
/// allocating.
pub fn lock_svc<'a, T>(
    mutex: &'a Mutex<T>,
    name: &'static str,
) -> Result<MutexGuard<'a, T>, ServiceError> {
    mutex.lock().map_err(|_| ServiceError::LockPoisoned(name))
}

// ---------------------------------------------------------------------------
// ServiceCtx
// ---------------------------------------------------------------------------

/// Everything a service function needs that is not one of its arguments.
///
/// `Clone + Send + Sync + 'static`, deliberately: a service can clone it into
/// its own `spawn_blocking` closure instead of the "clone the handle, re-resolve
/// the state inside" dance the bridge and `commands/pipeline.rs` do today.
#[derive(Clone)]
pub struct ServiceCtx {
    state: Arc<AppState>,
    events: Arc<dyn EventSink>,
    paths: Arc<dyn AppPaths>,
    spawner: Arc<dyn Spawner>,
    caller: Caller,
}

impl ServiceCtx {
    /// Assemble a context. Adapters call this; services never do.
    ///
    /// - `commands::adapters::ui_ctx(&app)` builds the [`Caller::Ui`] one.
    /// - `mcp_bridge::BridgeCtx::svc(client)` builds the [`Caller::Agent`] one.
    /// - `services::testing::test_ctx()` builds a Tauri-free one for tests.
    pub fn new(
        state: Arc<AppState>,
        events: Arc<dyn EventSink>,
        paths: Arc<dyn AppPaths>,
        spawner: Arc<dyn Spawner>,
        caller: Caller,
    ) -> Self {
        Self {
            state,
            events,
            paths,
            spawner,
            caller,
        }
    }

    /// Borrow the shared application state.
    pub fn state(&self) -> &AppState {
        &self.state
    }

    /// Clone the state handle, for moving into a spawned task.
    pub fn state_arc(&self) -> Arc<AppState> {
        Arc::clone(&self.state)
    }

    /// Broadcast event sink.
    pub fn events(&self) -> &dyn EventSink {
        &*self.events
    }

    /// Filesystem locations.
    pub fn paths(&self) -> &dyn AppPaths {
        &*self.paths
    }

    /// Background task spawner.
    pub fn spawner(&self) -> &dyn Spawner {
        &*self.spawner
    }

    /// Who is calling.
    pub fn caller(&self) -> &Caller {
        &self.caller
    }

    /// The same context under a different caller identity. Used where one
    /// transport performs work on another's behalf.
    pub fn with_caller(&self, caller: Caller) -> Self {
        let mut next = self.clone();
        next.caller = caller;
        next
    }

    /// Record a state-changing action in the shared activity journal **and**
    /// emit it as the `activity` event, so a UI listener sees agent actions
    /// live without polling.
    ///
    /// Called by services, never by adapters — that is what makes the feed
    /// complete rather than per-transport. Reads are never journaled.
    ///
    /// Returns the stored entry so a caller can assert on it (and so the
    /// emitted payload is provably the same value that was stored).
    pub fn journal(
        &self,
        action: &str,
        session_id: Option<&str>,
        summary: impl Into<String>,
    ) -> ActivityEntry {
        let entry = self.state.activity.push(
            self.caller.clone(),
            action,
            session_id,
            summary,
        );
        self.events
            .emit_json("activity", serde_json::to_value(&entry).unwrap_or_default());
        entry
    }
}

impl std::fmt::Debug for ServiceCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The trait objects have no useful Debug; the caller is the part worth
        // seeing in a test failure.
        f.debug_struct("ServiceCtx")
            .field("caller", &self.caller)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::test_ctx;
    use super::*;

    // ── The isolation rule ─────────────────────────────────────────────────

    /// `services/` must never depend on Tauri. This reads the directory at test
    /// time rather than trusting a convention, so a new file added by a later
    /// work package is covered automatically.
    ///
    /// Textual on purpose: the point is that nobody can even *reach* for
    /// `tauri::` here, including inside a `#[cfg]` block a type check might not
    /// visit.
    #[test]
    fn services_module_never_imports_tauri() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("services");
        let mut offenders: Vec<String> = Vec::new();
        let mut checked = 0usize;

        let entries = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()));
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let body = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
            checked += 1;
            for (i, line) in body.lines().enumerate() {
                // Skip doc comments and plain comments: the rule is about code,
                // and the module docs necessarily *mention* Tauri.
                let trimmed = line.trim_start();
                if trimmed.starts_with("//") {
                    continue;
                }
                // Needles are assembled from fragments so this very file — which
                // the scan also reads — does not match itself.
                if trimmed.contains(concat!("use ", "tauri"))
                    || trimmed.contains(concat!("tauri", "::"))
                {
                    offenders.push(format!("{}:{}: {}", path.display(), i + 1, line.trim()));
                }
            }
        }

        assert!(checked >= 8, "expected to scan the services module, saw {checked} files");
        assert!(
            offenders.is_empty(),
            "services/ must stay Tauri-free — move this into commands/adapters.rs:\n{}",
            offenders.join("\n")
        );
    }

    // ── Caller ─────────────────────────────────────────────────────────────

    #[test]
    fn caller_serializes_tagged_by_kind() {
        assert_eq!(
            serde_json::to_value(Caller::Ui).unwrap(),
            serde_json::json!({ "kind": "ui" })
        );
        assert_eq!(
            serde_json::to_value(Caller::agent("claude-code")).unwrap(),
            serde_json::json!({ "kind": "agent", "client": "claude-code" })
        );
    }

    #[test]
    fn caller_labels_and_predicates() {
        assert!(!Caller::Ui.is_agent());
        assert_eq!(Caller::Ui.label(), "ui");
        let a = Caller::agent("mcp");
        assert!(a.is_agent());
        assert_eq!(a.label(), "mcp");
    }

    // ── lock_svc ───────────────────────────────────────────────────────────

    #[test]
    fn lock_svc_returns_the_guard_when_healthy() {
        let m = Mutex::new(7u32);
        assert_eq!(*lock_svc(&m, "sessions").unwrap(), 7);
    }

    #[test]
    fn lock_svc_maps_poison_to_the_same_message_as_lock_or_err() {
        let m = Arc::new(Mutex::new(0u8));
        let poisoner = Arc::clone(&m);
        let joined = std::thread::spawn(move || {
            let _g = poisoner.lock().expect("lock not yet poisoned");
            panic!("simulated writer panic");
        })
        .join();
        assert!(joined.is_err());

        let svc_err = lock_svc(&m, "pipeline_results").unwrap_err();
        let cmd_err = crate::commands::lock_or_err(&m, "pipeline_results").unwrap_err();
        assert_eq!(svc_err, ServiceError::LockPoisoned("pipeline_results"));
        assert_eq!(svc_err.message(), cmd_err);
    }

    // ── ServiceCtx ─────────────────────────────────────────────────────────

    #[test]
    fn journal_appends_to_the_state_and_emits_the_same_entry() {
        let (ctx, sink, _tmp) = test_ctx().agent("claude-code").build_recording();

        let entry = ctx.journal("bookmark.create", Some("s1"), "line 42: ANR");

        // Stored…
        let stored = ctx.state().activity.list(None, None);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0], entry);
        assert_eq!(stored[0].action, "bookmark.create");
        assert_eq!(stored[0].session_id.as_deref(), Some("s1"));
        assert_eq!(stored[0].caller, Caller::agent("claude-code"));

        // …and emitted, as the very same value.
        let payload = sink.only_event("activity");
        assert_eq!(payload, serde_json::to_value(&entry).unwrap());
        assert_eq!(payload["caller"]["kind"], "agent");
        assert_eq!(payload["summary"], "line 42: ANR");
    }

    #[test]
    fn journal_stamps_the_contexts_own_caller() {
        let (ui, _t1) = test_ctx().build();
        ui.journal("session.open", Some("s1"), "opened");
        assert_eq!(ui.state().activity.list(None, None)[0].caller, Caller::Ui);
    }

    #[test]
    fn with_caller_swaps_identity_and_keeps_the_state() {
        let (ui, _tmp) = test_ctx().with_session("s1", 1).build();
        let agent = ui.with_caller(Caller::agent("mcp"));
        assert_eq!(*agent.caller(), Caller::agent("mcp"));
        // Same underlying state — a journal entry through either is visible to both.
        agent.journal("watch.create", Some("s1"), "w");
        assert_eq!(ui.state().activity.len(), 1);
    }

    #[test]
    fn state_arc_shares_the_same_state() {
        let (ctx, _tmp) = test_ctx().build();
        let arc = ctx.state_arc();
        ctx.journal("a", None, "b");
        assert_eq!(arc.activity.len(), 1);
    }

    #[test]
    fn debug_shows_the_caller() {
        let (ctx, _tmp) = test_ctx().agent("mcp").build();
        let s = format!("{ctx:?}");
        assert!(s.contains("Agent"), "{s}");
    }
}
