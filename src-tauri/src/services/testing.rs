//! Test doubles and fixtures for the service layer.
//!
//! Compiled under `#[cfg(test)]` and behind the `test-support` feature, so
//! integration tests in `src-tauri/tests/` (which link the `app_lib` rlib from
//! outside) can use the same builders the inline unit tests do:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --features test-support
//! ```
//!
//! The point of [`test_ctx`] is that a service function is testable with **no
//! Tauri anywhere** — no `AppHandle`, no webview, no event loop. If a service
//! cannot be exercised through this builder, it has a Tauri dependency it
//! should not have.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tempfile::TempDir;

use crate::core::line::{LineMeta, LogLevel};
use crate::core::session::AnalysisSession;

use super::events::{EventSink, ProgressEvent, ProgressSink, Sink};
use super::paths::{FixedPaths, NullSpawner};
use super::{AppState, Caller, ServiceCtx};

// ---------------------------------------------------------------------------
// RecordingSink
// ---------------------------------------------------------------------------

/// One recorded emission.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedEvent {
    pub name: String,
    pub payload: Value,
}

/// An [`EventSink`] / [`ProgressSink`] / [`Sink<T>`] that remembers everything
/// it was handed, so a test can assert on what a service emitted.
#[derive(Debug, Default)]
pub struct RecordingSink {
    events: Mutex<Vec<RecordedEvent>>,
    progress: Mutex<Vec<ProgressEvent>>,
}

impl RecordingSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every event, in emission order.
    pub fn events(&self) -> Vec<RecordedEvent> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Every event emitted under `name`, in order.
    pub fn events_named(&self, name: &str) -> Vec<RecordedEvent> {
        self.events()
            .into_iter()
            .filter(|e| e.name == name)
            .collect()
    }

    /// The payload of the single event emitted under `name`.
    ///
    /// Panics when zero or more than one was emitted — a test asserting on
    /// "the" event should fail loudly if the service emitted twice.
    pub fn only_event(&self, name: &str) -> Value {
        let mut found = self.events_named(name);
        assert_eq!(
            found.len(),
            1,
            "expected exactly one '{name}' event, got {}",
            found.len()
        );
        found.remove(0).payload
    }

    /// True when nothing at all was emitted.
    pub fn is_empty(&self) -> bool {
        self.events().is_empty() && self.progress_events().is_empty()
    }

    /// Every progress report, in order.
    pub fn progress_events(&self) -> Vec<ProgressEvent> {
        self.progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Forget everything recorded so far.
    pub fn clear(&self) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
}

impl EventSink for RecordingSink {
    fn emit_json(&self, event: &str, payload: Value) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(RecordedEvent {
                name: event.to_string(),
                payload,
            });
    }
}

impl ProgressSink for RecordingSink {
    fn on_progress(&self, ev: &ProgressEvent) {
        self.progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(ev.clone());
    }
}

/// Records typed stream items as JSON events named `sink`, so a `Sink<T>`
/// consumer can be asserted on with the same recorder.
impl<T: serde::Serialize + Send + Sync> Sink<T> for RecordingSink {
    fn send(&self, item: T) {
        let payload = serde_json::to_value(&item).unwrap_or(Value::Null);
        self.emit_json("sink", payload);
    }
}

// ---------------------------------------------------------------------------
// Session fixtures
// ---------------------------------------------------------------------------

/// An in-memory session with `n` synthetic logcat lines, backed by a
/// `StreamLogSource` — no file, no mmap, no temp file to clean up.
///
/// Follows the `make_stream_source` pattern in `core/session.rs`'s own tests.
pub fn fixture_session(id: &str, n: usize) -> AnalysisSession {
    fixture_session_from(id, (0..n).map(|i| format!("line {i}")).collect())
}

/// Like [`fixture_session`], but every line carries an email address so
/// anonymization gating is observable.
pub fn fixture_session_with_pii(id: &str, n: usize) -> AnalysisSession {
    fixture_session_from(
        id,
        (0..n)
            .map(|i| format!("line {i} contact user{i}@example.com for access"))
            .collect(),
    )
}

/// An in-memory session containing exactly `lines`.
pub fn fixture_session_from(id: &str, lines: Vec<String>) -> AnalysisSession {
    let mut session = AnalysisSession::new(id.to_string());
    session.add_stream_source(
        format!("{id}-src"),
        "fixture".to_string(),
        std::env::temp_dir(),
    );
    if let Some(stream) = session.stream_source_mut() {
        for (i, line) in lines.into_iter().enumerate() {
            let ts = 1_000_000_000 + i as i64;
            stream.add_bytes((line.len() + 1) as u64);
            stream.push_raw_line(line);
            stream.maybe_set_first_ts(ts);
            stream.push_meta(LineMeta {
                level: LogLevel::Info,
                tag_id: 0,
                timestamp: ts,
                byte_offset: 0,
                byte_len: 0,
                is_section_boundary: false,
            });
        }
    }
    session
}

// ---------------------------------------------------------------------------
// test_ctx builder
// ---------------------------------------------------------------------------

/// Start building a Tauri-free [`ServiceCtx`]. See [`TestCtxBuilder`].
pub fn test_ctx() -> TestCtxBuilder {
    TestCtxBuilder::new()
}

/// Builder for a [`ServiceCtx`] backed by a fresh [`AppState`], a
/// [`RecordingSink`], and a `TempDir` standing in for the app data directory.
///
/// The `TempDir` is returned from `build()` and must be kept alive by the test
/// — dropping it deletes the directory out from under the context.
pub struct TestCtxBuilder {
    state: AppState,
    caller: Caller,
    tmp: TempDir,
}

impl TestCtxBuilder {
    pub fn new() -> Self {
        Self {
            state: AppState::new(),
            caller: Caller::Ui,
            tmp: tempfile::tempdir().expect("failed to create a temp dir for test_ctx"),
        }
    }

    /// Set the caller identity. Defaults to [`Caller::Ui`].
    pub fn caller(mut self, caller: Caller) -> Self {
        self.caller = caller;
        self
    }

    /// Shorthand for an agent caller identifying itself as `client`.
    pub fn agent(self, client: &str) -> Self {
        self.caller(Caller::Agent {
            client: client.to_string(),
        })
    }

    /// Register an in-memory session with `n` synthetic lines.
    pub fn with_session(self, id: &str, n: usize) -> Self {
        self.with_session_object(fixture_session(id, n))
    }

    /// Register an in-memory session whose lines all contain PII.
    pub fn with_pii_session(self, id: &str, n: usize) -> Self {
        self.with_session_object(fixture_session_with_pii(id, n))
    }

    /// Register a pre-built session.
    pub fn with_session_object(self, session: AnalysisSession) -> Self {
        self.state
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(session.id.clone(), session);
        self
    }

    /// Add `dir` to the MCP open-file allowlist.
    pub fn allowlist(self, dir: impl AsRef<std::path::Path>) -> Self {
        self.state
            .mcp_open_allowlist
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .allowed_dirs
            .push(dir.as_ref().to_string_lossy().to_string());
        self
    }

    /// Set the persisted agent raw-access opt-out (`AppState::agent_raw_access`).
    ///
    /// The default is `false` — agents are anonymized — so call this only to
    /// exercise the opt-out path. There is no per-session variant: agent
    /// visibility is one global, UI-only setting (see `policy::should_anonymize`).
    pub fn agent_raw_access(self, on: bool) -> Self {
        *self
            .state
            .agent_raw_access
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = on;
        self
    }

    /// Build the context. The `TempDir` is the context's `app_data_dir`.
    pub fn build(self) -> (ServiceCtx, TempDir) {
        let (ctx, _sink, tmp) = self.build_recording();
        (ctx, tmp)
    }

    /// Build the context and hand back the [`RecordingSink`] it emits through,
    /// for tests that assert on emitted events.
    pub fn build_recording(self) -> (ServiceCtx, Arc<RecordingSink>, TempDir) {
        let sink = Arc::new(RecordingSink::new());
        let ctx = ServiceCtx::new(
            Arc::new(self.state),
            Arc::clone(&sink) as Arc<dyn EventSink>,
            Arc::new(FixedPaths(self.tmp.path().to_path_buf())),
            Arc::new(NullSpawner),
            self.caller,
        );
        (ctx, sink, self.tmp)
    }
}

impl Default for TestCtxBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_session_has_readable_lines() {
        let s = fixture_session("s1", 3);
        let src = s.primary_source().expect("fixture has a source");
        assert_eq!(src.total_lines(), 3);
        assert_eq!(src.raw_line(0).as_deref(), Some("line 0"));
        assert_eq!(src.raw_line(2).as_deref(), Some("line 2"));
        assert!(src.raw_line(3).is_none());
    }

    #[test]
    fn fixture_session_with_pii_carries_an_email_per_line() {
        let s = fixture_session_with_pii("s1", 2);
        let src = s.primary_source().unwrap();
        assert!(src.raw_line(0).unwrap().contains("user0@example.com"));
        assert!(src.raw_line(1).unwrap().contains("user1@example.com"));
    }

    #[test]
    fn test_ctx_registers_sessions_and_defaults_to_a_ui_caller() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 5).build();
        assert_eq!(*ctx.caller(), Caller::Ui);
        let sessions = ctx.state().sessions.lock().unwrap();
        assert!(sessions.contains_key("s1"));
    }

    #[test]
    fn test_ctx_app_data_dir_is_the_temp_dir() {
        let (ctx, tmp) = test_ctx().build();
        assert_eq!(ctx.paths().app_data_dir().unwrap(), tmp.path());
    }

    #[test]
    fn recording_sink_captures_events_in_order() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        ctx.events().emit_json("a", serde_json::json!({ "n": 1 }));
        ctx.events().emit_json("b", serde_json::json!({ "n": 2 }));
        let got = sink.events();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "a");
        assert_eq!(got[1].payload["n"], 2);
        assert_eq!(sink.only_event("b")["n"], 2);
        assert!(sink.events_named("nope").is_empty());
    }

    #[test]
    fn recording_sink_captures_progress_separately_from_events() {
        use super::super::events::{IndexProgressEvent, ProgressEvent};
        let sink = RecordingSink::new();
        assert!(sink.is_empty());
        sink.on_progress(&ProgressEvent::Index(IndexProgressEvent {
            session_id: "s".into(),
            indexed_lines: 1,
            bytes_scanned: 2,
            total_bytes: 3,
        }));
        assert_eq!(sink.progress_events().len(), 1);
        assert!(sink.events().is_empty());
        assert!(!sink.is_empty());
        sink.clear();
        assert!(sink.is_empty());
    }

    #[test]
    fn agent_shorthand_sets_the_client_name() {
        let (ctx, _tmp) = test_ctx().agent("claude-code").build();
        assert_eq!(
            *ctx.caller(),
            Caller::Agent {
                client: "claude-code".to_string()
            }
        );
    }
}
