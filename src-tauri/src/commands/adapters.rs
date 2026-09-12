//! Tauri implementations of the `services` traits.
//!
//! This is the one file where the service layer's abstractions meet Tauri.
//! `services/` must never `use tauri` (pinned by a test there); everything it
//! needs from the desktop runtime — emitting events, resolving the app data
//! directory, spawning onto the runtime Tauri drives — arrives through one of
//! the implementations below.
//!
//! A `#[tauri::command]` adapter is expected to be three lines: build a
//! [`ui_ctx`], call one service function, `Ok(result?)`.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::services::events::{EventSink, ProgressEvent, ProgressSink, Sink};
use crate::services::paths::{AppPaths, Spawner};
use crate::services::{Caller, ServiceCtx, ServiceError};

// ---------------------------------------------------------------------------
// EventSink
// ---------------------------------------------------------------------------

/// Broadcasts service events to every webview via `AppHandle::emit`.
///
/// Emission failures are logged and swallowed: a dropped notification must not
/// fail the operation that produced it (the state change has already happened).
#[derive(Clone)]
pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        if let Err(e) = self.app.emit(event, payload) {
            log::warn!("[adapters] failed to emit '{event}': {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// ProgressSink
// ---------------------------------------------------------------------------

/// Maps each [`ProgressEvent`] variant onto the Tauri event name the frontend
/// already listens for, with the payload shape it already parses.
///
/// The names come from [`ProgressEvent::event_name`] so there is a single
/// source of truth; the typed payload is emitted directly rather than through
/// JSON so serialization stays identical to today's `app.emit(name, struct)`.
#[derive(Clone)]
pub struct TauriProgressSink {
    app: AppHandle,
}

impl TauriProgressSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ProgressSink for TauriProgressSink {
    fn on_progress(&self, ev: &ProgressEvent) {
        let name = ev.event_name();
        let sent = match ev {
            ProgressEvent::Pipeline(p) => self.app.emit(name, p),
            ProgressEvent::Search(p) => self.app.emit(name, p),
            ProgressEvent::Filter(p) => self.app.emit(name, p),
            ProgressEvent::Index(p) => self.app.emit(name, p),
        };
        if let Err(e) = sent {
            log::warn!("[adapters] failed to emit '{name}': {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// Sink<T> over a Tauri IPC Channel
// ---------------------------------------------------------------------------

/// Delivers typed stream items down one Tauri IPC `Channel`.
///
/// The UI half of the ADB streaming split: batches arrive at ~50ms intervals
/// and go to the one pane that asked for them, not to every listener (see
/// `commands/CLAUDE.md` on why `adb-batch` stopped being a broadcast event).
/// The agent half is `services::events::RingSink` with a `?since=` cursor.
///
/// A send failure means the frontend dropped the channel (pane closed, session
/// detached); it is logged at debug and ignored — the stream task's own
/// cancellation path is what stops production.
#[derive(Clone)]
pub struct ChannelSink<T: Clone + serde::Serialize + Send + Sync + 'static> {
    channel: tauri::ipc::Channel<T>,
}

impl<T: Clone + serde::Serialize + Send + Sync + 'static> ChannelSink<T> {
    pub fn new(channel: tauri::ipc::Channel<T>) -> Self {
        Self { channel }
    }
}

impl<T: Clone + serde::Serialize + Send + Sync + 'static> Sink<T> for ChannelSink<T> {
    fn send(&self, item: T) {
        if let Err(e) = self.channel.send(item) {
            log::debug!("[adapters] channel sink send failed (receiver gone): {e}");
        }
    }
}

/// The ADB streaming sink: `Channel<AdbStreamEvent>` carrying `Batch`,
/// `ProcessorUpdate`, `StreamStopped` and `ProcessorsExcluded` to one pane.
pub type AdbChannelSink = ChannelSink<crate::services::stream::AdbStreamEvent>;

// ---------------------------------------------------------------------------
// AppPaths
// ---------------------------------------------------------------------------

/// Resolves the app data directory through `AppHandle::path()`.
#[derive(Clone)]
pub struct TauriPaths {
    app: AppHandle,
}

impl TauriPaths {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl AppPaths for TauriPaths {
    fn app_data_dir(&self) -> Result<PathBuf, ServiceError> {
        self.app
            .path()
            .app_data_dir()
            .map_err(|e| ServiceError::Internal(e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Spawner
// ---------------------------------------------------------------------------

/// Spawns onto the runtime Tauri drives.
///
/// `tauri::async_runtime::spawn` specifically, not `tokio::spawn`: the
/// background file indexer in `commands/files.rs` depends on landing on that
/// runtime.
#[derive(Clone, Copy, Default)]
pub struct TauriSpawner;

impl Spawner for TauriSpawner {
    fn spawn(&self, fut: futures_util::future::BoxFuture<'static, ()>) {
        tauri::async_runtime::spawn(fut);
    }
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

/// Build a [`ServiceCtx`] for the desktop UI.
///
/// One of exactly two places a [`Caller`] is constructed — the other is
/// `mcp_bridge::BridgeCtx::svc`, which produces [`Caller::Agent`]. Every
/// `#[tauri::command]` that calls a service goes through here, so "this request
/// came from the human at the keyboard" is asserted in one place.
pub fn ui_ctx(app: &AppHandle) -> ServiceCtx {
    ServiceCtx::new(
        Arc::clone(&*app.state::<Arc<AppState>>()),
        Arc::new(TauriSink::new(app.clone())),
        Arc::new(TauriPaths::new(app.clone())),
        Arc::new(TauriSpawner),
        Caller::Ui,
    )
}

#[cfg(test)]
mod tests {
    use crate::services::events::{
        FilterProgressEvent, IndexProgressEvent, PipelineProgressEvent, ProgressEvent,
        SearchProgressEvent,
    };
    use crate::services::testing::test_ctx;
    use crate::services::Caller;

    /// The adapters themselves need a live `AppHandle`, which this suite does
    /// not construct (same constraint the bridge handlers have). What IS
    /// testable without one is the name mapping `TauriProgressSink` emits
    /// under — the actual contract with the frontend listeners.
    #[test]
    fn progress_sink_maps_every_variant_to_todays_event_name() {
        let cases: Vec<(ProgressEvent, &str)> = vec![
            (
                ProgressEvent::Pipeline(PipelineProgressEvent {
                    session_id: "s".into(),
                    processor_id: "p".into(),
                    lines_processed: 0,
                    total_lines: 0,
                    percent: 0.0,
                }),
                "pipeline-progress",
            ),
            (
                ProgressEvent::Search(SearchProgressEvent {
                    session_id: "s".into(),
                    matched_so_far: 0,
                    lines_scanned: 0,
                    total_lines: 0,
                    new_matches: vec![],
                    done: false,
                }),
                "search-progress",
            ),
            (
                ProgressEvent::Filter(FilterProgressEvent {
                    filter_id: "f".into(),
                    matched_so_far: 0,
                    lines_scanned: 0,
                    total_lines: 0,
                    done: false,
                }),
                "filter-progress",
            ),
            (
                ProgressEvent::Index(IndexProgressEvent {
                    session_id: "s".into(),
                    indexed_lines: 0,
                    bytes_scanned: 0,
                    total_bytes: 0,
                }),
                "file-index-progress",
            ),
        ];
        for (ev, expected) in cases {
            assert_eq!(ev.event_name(), expected);
        }
    }

    /// `AdbChannelSink` must satisfy `Sink<AdbStreamEvent>` — the trait the ADB
    /// stream service will hand batches to, with `RingSink` as the agent-side
    /// implementation of the same trait.
    #[test]
    fn adb_channel_sink_implements_the_stream_sink_trait() {
        fn assert_sink<S: crate::services::events::Sink<crate::services::stream::AdbStreamEvent>>() {}
        assert_sink::<super::AdbChannelSink>();
    }

    /// `ui_ctx` needs an `AppHandle`, but the identity it stamps is the point:
    /// a UI-built context journals as `Caller::Ui`, which is what the activity
    /// feed and every `policy` gate branch on.
    #[test]
    fn a_ui_context_journals_as_the_ui_caller() {
        let (ctx, sink, _tmp) = test_ctx().build_recording();
        assert_eq!(*ctx.caller(), Caller::Ui);
        ctx.journal("session.open", Some("s1"), "opened dumpstate.txt");
        let payload = sink.only_event("activity");
        assert_eq!(payload["caller"]["kind"], "ui");
        assert_eq!(payload["action"], "session.open");
    }
}
