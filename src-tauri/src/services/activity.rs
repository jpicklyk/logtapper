//! The shared activity journal.
//!
//! One feed carrying every state-changing action, whoever performed it — the
//! user in the UI or an agent over the MCP bridge. It exists so the two
//! callers can work the same workspace in parallel without either being blind
//! to what the other did.
//!
//! Written exclusively through [`super::ServiceCtx::journal`], never by an
//! adapter, so a mutation cannot land in one transport's feed and not the
//! other's. Reads are not journaled — only mutations.
//!
//! Surfaced by the `get_activity` command and `GET /mcp/activity`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;

use super::Caller;

/// How many entries the journal retains. Older entries are dropped from the
/// front. This is a live feed, not an audit log — a consumer that wants
/// everything must poll faster than the cap fills.
pub const ACTIVITY_CAP: usize = 500;

/// One journaled action.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// Monotonic id, unique for the life of the process. Consumers poll with
    /// `since_id` and receive everything strictly newer.
    pub id: u64,
    /// Unix epoch milliseconds.
    pub ts: u64,
    /// Who did it.
    pub caller: Caller,
    /// Dotted action name, e.g. `session.open`, `bookmark.create`.
    pub action: String,
    /// The session the action applied to, when it applied to one.
    pub session_id: Option<String>,
    /// Short human-readable description.
    pub summary: String,
}

/// A bounded, sequence-numbered ring of [`ActivityEntry`].
#[derive(Debug)]
pub struct ActivityJournal {
    seq: AtomicU64,
    entries: Mutex<VecDeque<ActivityEntry>>,
    cap: usize,
}

impl Default for ActivityJournal {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityJournal {
    pub fn new() -> Self {
        Self::with_cap(ACTIVITY_CAP)
    }

    /// Test hook: a journal with a smaller cap so eviction is exercisable
    /// without pushing 500 entries.
    pub fn with_cap(cap: usize) -> Self {
        Self {
            seq: AtomicU64::new(0),
            entries: Mutex::new(VecDeque::new()),
            cap: cap.max(1),
        }
    }

    /// Append an entry and return it (so the caller can emit the very same
    /// value it stored rather than rebuilding it).
    ///
    /// Never fails: on a poisoned lock it recovers via `into_inner`. The
    /// journal is a flat append-only ring with no cross-field invariant, so a
    /// panicking writer cannot leave it torn — the same reasoning that governs
    /// the `into_inner` family of `AppState` locks in `mcp_bridge`.
    pub fn push(
        &self,
        caller: Caller,
        action: impl Into<String>,
        session_id: Option<&str>,
        summary: impl Into<String>,
    ) -> ActivityEntry {
        let entry = ActivityEntry {
            id: self.seq.fetch_add(1, Ordering::Relaxed) + 1,
            ts: now_millis(),
            caller,
            action: action.into(),
            session_id: session_id.map(str::to_string),
            summary: summary.into(),
        };

        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if entries.len() >= self.cap {
            entries.pop_front();
        }
        entries.push_back(entry.clone());
        entry
    }

    /// Entries newer than `since_id`, oldest first, capped at `limit`.
    ///
    /// When `limit` cuts the result, the NEWEST entries are kept — a caller
    /// asking for "the last 20 things that happened" gets the last 20, not the
    /// 20 oldest still retained.
    pub fn list(&self, limit: Option<usize>, since_id: Option<u64>) -> Vec<ActivityEntry> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let since = since_id.unwrap_or(0);
        let mut out: Vec<ActivityEntry> =
            entries.iter().filter(|e| e.id > since).cloned().collect();
        if let Some(n) = limit {
            if out.len() > n {
                out.drain(..out.len() - n);
            }
        }
        out
    }

    /// Number of entries currently retained.
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    /// True when nothing has been journaled (or everything aged out, which
    /// cannot happen — the ring only evicts when pushing).
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The highest id issued so far (0 before the first push).
    pub fn latest_id(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> Caller {
        Caller::Agent {
            client: "mcp".to_string(),
        }
    }

    #[test]
    fn push_returns_the_stored_entry_with_an_increasing_id() {
        let j = ActivityJournal::new();
        let a = j.push(Caller::Ui, "session.open", Some("s1"), "opened foo.log");
        let b = j.push(agent(), "bookmark.create", Some("s1"), "line 42");
        assert_eq!(a.id, 1);
        assert_eq!(b.id, 2);
        assert_eq!(a.action, "session.open");
        assert_eq!(a.session_id.as_deref(), Some("s1"));
        assert_eq!(j.latest_id(), 2);
        assert_eq!(j.len(), 2);
    }

    #[test]
    fn entries_serialize_camel_case_with_a_tagged_caller() {
        let j = ActivityJournal::new();
        let e = j.push(agent(), "watch.create", None, "watch on ANR");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["action"], "watch.create");
        assert_eq!(v["sessionId"], serde_json::Value::Null);
        assert_eq!(v["caller"]["kind"], "agent");
        assert_eq!(v["caller"]["client"], "mcp");
        assert!(v["ts"].as_u64().unwrap() > 0);
    }

    #[test]
    fn journal_is_bounded_and_drops_the_oldest() {
        let j = ActivityJournal::with_cap(3);
        for i in 0..5 {
            j.push(Caller::Ui, "x", None, format!("n{i}"));
        }
        assert_eq!(j.len(), 3);
        let all = j.list(None, None);
        assert_eq!(all.len(), 3);
        // ids 1 and 2 evicted; 3,4,5 retained in order.
        assert_eq!(all[0].id, 3);
        assert_eq!(all[2].id, 5);
    }

    #[test]
    fn default_cap_is_500() {
        let j = ActivityJournal::new();
        for _ in 0..600 {
            j.push(Caller::Ui, "x", None, "y");
        }
        assert_eq!(j.len(), ACTIVITY_CAP);
        assert_eq!(ACTIVITY_CAP, 500);
        assert_eq!(j.latest_id(), 600);
        assert_eq!(j.list(None, None)[0].id, 101);
    }

    #[test]
    fn since_id_returns_only_strictly_newer_entries() {
        let j = ActivityJournal::new();
        j.push(Caller::Ui, "a", None, "1");
        let second = j.push(Caller::Ui, "b", None, "2");
        j.push(Caller::Ui, "c", None, "3");
        let got = j.list(None, Some(second.id));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].action, "c");
    }

    #[test]
    fn limit_keeps_the_newest_entries() {
        let j = ActivityJournal::new();
        for i in 0..10 {
            j.push(Caller::Ui, "x", None, format!("n{i}"));
        }
        let got = j.list(Some(3), None);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].id, 8);
        assert_eq!(got[2].id, 10);
    }

    #[test]
    fn empty_journal_lists_nothing() {
        let j = ActivityJournal::new();
        assert!(j.is_empty());
        assert!(j.list(Some(10), None).is_empty());
        assert_eq!(j.latest_id(), 0);
    }

    #[test]
    fn push_recovers_from_a_poisoned_lock_instead_of_panicking() {
        let j = std::sync::Arc::new(ActivityJournal::new());
        j.push(Caller::Ui, "seeded", None, "before poison");

        let poisoner = std::sync::Arc::clone(&j);
        let joined = std::thread::spawn(move || {
            let _g = poisoner.entries.lock().expect("lock not yet poisoned");
            panic!("simulated writer panic while holding the journal");
        })
        .join();
        assert!(joined.is_err());
        assert!(j.entries.is_poisoned());

        let e = j.push(Caller::Ui, "after", None, "recovered");
        assert_eq!(e.id, 2);
        assert_eq!(j.list(None, None).len(), 2);
    }
}
