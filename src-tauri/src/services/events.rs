//! Outbound notification abstractions.
//!
//! Services never talk to Tauri or Axum directly — they push through one of
//! these traits and the transport adapter decides what that means. The Tauri
//! implementations (`TauriSink`, `TauriProgressSink`, `ChannelSink`) live in
//! `commands/adapters.rs`; test doubles live in [`super::testing`].
//!
//! Three shapes, deliberately distinct:
//!
//! - [`EventSink`] — broadcast, fire-and-forget, JSON payload. Backs today's
//!   `app.emit(name, payload)` calls (`session-opened`, `bookmark-update`, …).
//! - [`ProgressSink`] — a closed set of long-running-operation progress
//!   reports. Closed so the adapter can map each variant onto the event name
//!   the frontend already listens for.
//! - [`Sink<T>`] — a typed, per-consumer stream (ADB batches). The UI adapter
//!   forwards into a Tauri IPC `Channel`; the agent adapter buffers into a
//!   [`RingSink`] that an HTTP route drains with a `?since=` cursor.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// EventSink — broadcast app events
// ---------------------------------------------------------------------------

/// Broadcast a named event with a JSON payload to whatever is listening.
///
/// Implementations must never block for long and must never panic: a failed
/// emit is a dropped notification, not a failed operation.
pub trait EventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload: Value);
}

/// An [`EventSink`] that discards everything. Used by contexts with no UI
/// attached (and as the default in tests that do not assert on events).
#[derive(Debug, Clone, Copy, Default)]
pub struct NullSink;

impl EventSink for NullSink {
    fn emit_json(&self, _event: &str, _payload: Value) {}
}

// ---------------------------------------------------------------------------
// ProgressSink — long-running operation progress
// ---------------------------------------------------------------------------

/// Payload of the `pipeline-progress` event. Field-for-field identical to
/// `commands::pipeline::PipelineProgress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineProgressEvent {
    pub session_id: String,
    pub processor_id: String,
    pub lines_processed: usize,
    pub total_lines: usize,
    pub percent: f32,
}

/// Payload of the `search-progress` event. Field-for-field identical to
/// `commands::files::SearchProgress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgressEvent {
    pub session_id: String,
    pub matched_so_far: usize,
    pub lines_scanned: usize,
    pub total_lines: usize,
    pub new_matches: Vec<usize>,
    pub done: bool,
}

/// Payload of the `filter-progress` event. Field-for-field identical to
/// `commands::filter::FilterProgress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterProgressEvent {
    pub filter_id: String,
    pub matched_so_far: usize,
    pub lines_scanned: usize,
    pub total_lines: usize,
    pub done: bool,
}

/// Payload of the `file-index-progress` event. Field-for-field identical to
/// `commands::files::FileIndexProgress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgressEvent {
    pub session_id: String,
    pub indexed_lines: usize,
    pub bytes_scanned: usize,
    pub total_bytes: usize,
}

/// The closed set of progress reports a service can produce.
///
/// [`ProgressEvent::event_name`] is the single source of truth for the wire
/// name each variant carries; `TauriProgressSink` emits under exactly that
/// name so the existing frontend listeners keep working unchanged.
#[derive(Debug, Clone, PartialEq)]
pub enum ProgressEvent {
    Pipeline(PipelineProgressEvent),
    Search(SearchProgressEvent),
    Filter(FilterProgressEvent),
    Index(IndexProgressEvent),
}

impl ProgressEvent {
    /// The event name this variant is delivered under. These are the names the
    /// frontend already listens for — changing one is a breaking UI change.
    pub fn event_name(&self) -> &'static str {
        match self {
            ProgressEvent::Pipeline(_) => "pipeline-progress",
            ProgressEvent::Search(_) => "search-progress",
            ProgressEvent::Filter(_) => "filter-progress",
            ProgressEvent::Index(_) => "file-index-progress",
        }
    }

    /// The payload as JSON, in the exact camelCase shape today's listeners
    /// receive. Used by test doubles and by any sink that speaks JSON.
    pub fn payload(&self) -> Value {
        match self {
            ProgressEvent::Pipeline(p) => json!(p),
            ProgressEvent::Search(p) => json!(p),
            ProgressEvent::Filter(p) => json!(p),
            ProgressEvent::Index(p) => json!(p),
        }
    }
}

/// Receive [`ProgressEvent`]s from a long-running service operation.
pub trait ProgressSink: Send + Sync {
    fn on_progress(&self, ev: &ProgressEvent);
}

/// A [`ProgressSink`] that discards everything.
#[derive(Debug, Clone, Copy, Default)]
pub struct NullProgressSink;

impl ProgressSink for NullProgressSink {
    fn on_progress(&self, _ev: &ProgressEvent) {}
}

// ---------------------------------------------------------------------------
// Sink<T> — typed per-consumer streams
// ---------------------------------------------------------------------------

/// A typed, per-consumer delivery channel. Unlike [`EventSink`] this is not a
/// broadcast: one sink belongs to one consumer (one UI pane's IPC channel, or
/// one agent's ring buffer).
pub trait Sink<T>: Send + Sync {
    fn send(&self, item: T);
}

/// One buffered item plus the monotonic sequence number it was stored under.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeqItem<T> {
    pub seq: u64,
    pub item: T,
}

/// A bounded ring buffer with a monotonic sequence cursor.
///
/// Backs the agent-side ADB stream: an agent has no persistent socket, so it
/// polls `GET .../stream?since=<seq>` and gets everything newer than its
/// cursor. Sequence numbers keep increasing even after eviction, so a consumer
/// that fell behind sees a gap between its cursor and the oldest retained item
/// rather than silently re-reading.
pub struct RingSink<T> {
    cap: usize,
    seq: AtomicU64,
    buf: Mutex<VecDeque<SeqItem<T>>>,
}

impl<T> RingSink<T> {
    /// Create a ring holding at most `cap` items (`cap` of 0 is coerced to 1 —
    /// a zero-capacity ring would silently discard everything).
    pub fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            seq: AtomicU64::new(0),
            buf: Mutex::new(VecDeque::new()),
        }
    }

    /// Capacity this ring was built with.
    pub fn capacity(&self) -> usize {
        self.cap
    }

    /// The highest sequence number issued so far (0 before the first push).
    pub fn latest_seq(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }

    /// Push an item, evicting the oldest if the ring is full. Returns the
    /// sequence number assigned to it.
    pub fn push(&self, item: T) -> u64 {
        // Sequence numbers start at 1 so `drain_since(0)` means "everything".
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mut buf = self
            .buf
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if buf.len() >= self.cap {
            buf.pop_front();
        }
        buf.push_back(SeqItem { seq, item });
        seq
    }

    /// Number of items currently retained.
    pub fn len(&self) -> usize {
        self.buf
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// True when nothing is retained.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<T: Clone> RingSink<T> {
    /// Every retained item with `seq > since`, oldest first. Non-destructive:
    /// items stay until evicted by capacity, so two consumers with independent
    /// cursors both see them.
    pub fn drain_since(&self, since: u64) -> Vec<SeqItem<T>> {
        let buf = self
            .buf
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        buf.iter().filter(|e| e.seq > since).cloned().collect()
    }
}

impl<T: Send + Sync> Sink<T> for RingSink<T> {
    fn send(&self, item: T) {
        self.push(item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_event_names_match_todays_tauri_events() {
        // These four strings are the contract with the existing frontend
        // listeners. Renaming one here silently breaks the UI.
        let p = ProgressEvent::Pipeline(PipelineProgressEvent {
            session_id: "s".into(),
            processor_id: "p".into(),
            lines_processed: 1,
            total_lines: 2,
            percent: 50.0,
        });
        assert_eq!(p.event_name(), "pipeline-progress");

        let s = ProgressEvent::Search(SearchProgressEvent {
            session_id: "s".into(),
            matched_so_far: 1,
            lines_scanned: 2,
            total_lines: 3,
            new_matches: vec![1],
            done: false,
        });
        assert_eq!(s.event_name(), "search-progress");

        let f = ProgressEvent::Filter(FilterProgressEvent {
            filter_id: "f".into(),
            matched_so_far: 1,
            lines_scanned: 2,
            total_lines: 3,
            done: true,
        });
        assert_eq!(f.event_name(), "filter-progress");

        let i = ProgressEvent::Index(IndexProgressEvent {
            session_id: "s".into(),
            indexed_lines: 1,
            bytes_scanned: 2,
            total_bytes: 3,
        });
        assert_eq!(i.event_name(), "file-index-progress");
    }

    #[test]
    fn progress_payloads_are_camel_case_and_untagged() {
        let f = ProgressEvent::Filter(FilterProgressEvent {
            filter_id: "f1".into(),
            matched_so_far: 3,
            lines_scanned: 40,
            total_lines: 100,
            done: false,
        });
        let v = f.payload();
        // No enum tag in the payload — the name carries the discriminant.
        assert_eq!(v["filterId"], "f1");
        assert_eq!(v["matchedSoFar"], 3);
        assert_eq!(v["linesScanned"], 40);
        assert_eq!(v["totalLines"], 100);
        assert_eq!(v["done"], false);
        assert_eq!(v.as_object().map(serde_json::Map::len), Some(5));
    }

    #[test]
    fn ring_sink_assigns_increasing_sequences_from_one() {
        let r: RingSink<u32> = RingSink::new(4);
        assert_eq!(r.latest_seq(), 0);
        assert_eq!(r.push(10), 1);
        assert_eq!(r.push(20), 2);
        assert_eq!(r.latest_seq(), 2);
    }

    #[test]
    fn ring_sink_drain_since_zero_returns_everything() {
        let r: RingSink<u32> = RingSink::new(4);
        r.push(10);
        r.push(20);
        let got = r.drain_since(0);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].item, 10);
        assert_eq!(got[1].seq, 2);
    }

    #[test]
    fn ring_sink_drain_since_is_non_destructive_and_cursor_scoped() {
        let r: RingSink<u32> = RingSink::new(4);
        r.push(1);
        r.push(2);
        r.push(3);
        assert_eq!(r.drain_since(1).len(), 2);
        // Still all there — a second consumer with its own cursor sees them.
        assert_eq!(r.drain_since(0).len(), 3);
        assert_eq!(r.drain_since(3).len(), 0);
    }

    #[test]
    fn ring_sink_evicts_oldest_beyond_capacity_but_keeps_sequences_monotonic() {
        let r: RingSink<u32> = RingSink::new(2);
        r.push(1);
        r.push(2);
        r.push(3);
        assert_eq!(r.len(), 2);
        let got = r.drain_since(0);
        // Seq 1 is gone; the caller can tell from the seq gap that it missed it.
        assert_eq!(got[0].seq, 2);
        assert_eq!(got[1].seq, 3);
        assert_eq!(r.latest_seq(), 3);
    }

    #[test]
    fn ring_sink_zero_capacity_is_coerced_to_one() {
        let r: RingSink<u32> = RingSink::new(0);
        assert_eq!(r.capacity(), 1);
        r.push(7);
        assert_eq!(r.drain_since(0).len(), 1);
    }

    #[test]
    fn ring_sink_is_a_sink() {
        let r: RingSink<u32> = RingSink::new(4);
        let as_sink: &dyn Sink<u32> = &r;
        as_sink.send(99);
        assert_eq!(r.drain_since(0)[0].item, 99);
    }

    #[test]
    fn null_sinks_swallow_everything() {
        let e: &dyn EventSink = &NullSink;
        e.emit_json("anything", json!({ "a": 1 }));
        let p: &dyn ProgressSink = &NullProgressSink;
        p.on_progress(&ProgressEvent::Index(IndexProgressEvent {
            session_id: "s".into(),
            indexed_lines: 0,
            bytes_scanned: 0,
            total_bytes: 0,
        }));
    }
}
