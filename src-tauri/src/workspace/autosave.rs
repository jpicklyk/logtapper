//! Backend-side auto-save scheduler and flush logic (Q4 — P0-a Stage 2).
//!
//! Artifacts written over the MCP bridge bypass the frontend entirely, so
//! durability cannot depend on a live, listening window. This module owns a
//! debounced background flusher: any handler may call [`schedule_autosave`]
//! (sync, non-blocking) after mutating `AppState`, and ~3 s later the flusher
//! merges the last frontend-supplied [`WorkspaceEnvelope`] (name / editor tabs /
//! layout / chain — the parts the backend cannot reconstruct) with a fresh
//! session snapshot and writes the `.ltw`, then records the auto-save into
//! `app-state.json` and emits `workspace-auto-saved`.
//!
//! Lock discipline (see `commands/CLAUDE.md`): the envelope is cloned under a
//! brief lock and the guard dropped before any `.await`; `collect_session_data`
//! is already lock-disciplined; the actual file I/O runs on `spawn_blocking`
//! and serialises against the command-path writers via the shared
//! `ltw_write_lock` / `app_state_write_lock` (held only across the sync write,
//! never across an `.await`).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::commands::workspace_cmd::{collect_session_data, entry_refs, SessionEntry};
use crate::commands::AppState;
use crate::workspace::app_state::{load_app_state, save_app_state};
use crate::workspace::ltw_v4::{self, LtwEditorTab, LtwLayout, LtwPipelineChain};

/// Debounce window: a burst of `schedule_autosave` signals collapses into one
/// flush once this much quiet has elapsed.
const DEBOUNCE_MS: u64 = 3000;

/// How many auto-save `.ltw` files to keep in the id-keyed `workspaces/` dir.
///
/// Only workspaces without an explicit user save land there (one file per
/// workspace id, rewritten in place each flush — so an active workspace's file
/// is always among the newest and never evicted out from under it). Ten covers
/// a realistic concurrent working set plus recent history for crash recovery,
/// while bounding growth from churned/deleted workspace ids whose files linger.
const EVICT_KEEP: usize = 10;

/// The last frontend-supplied workspace "shell". The backend can snapshot
/// sessions + artifacts on its own, but the workspace name, editor tabs, layout
/// blob and pipeline chain only ever originate in the frontend — this cache
/// carries them so a flush can rebuild a complete file. Refreshed by every
/// `save_workspace_v4` / `auto_save_workspace` call and by `sync_workspace_envelope`.
#[derive(Debug, Clone)]
pub struct WorkspaceEnvelope {
    pub workspace_id: String,
    pub workspace_name: String,
    /// Explicit `.ltw` path if the workspace has one, else `None` (flush then
    /// writes the id-keyed `workspaces/{workspace_id}.ltw`).
    pub ltw_path: Option<String>,
    pub editor_tabs: Vec<LtwEditorTab>,
    pub layout: Option<LtwLayout>,
    pub pipeline_chain: LtwPipelineChain,
    /// Epoch-millis when this envelope was cached (diagnostics only).
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// Public API — called from command / MCP handlers
// ---------------------------------------------------------------------------

/// Replace the cached workspace envelope. Cheap in-memory write.
pub fn cache_envelope(state: &AppState, envelope: WorkspaceEnvelope) {
    if let Ok(mut guard) = state.workspace_envelope.lock() {
        *guard = Some(envelope);
    }
}

/// Signal the background flusher to schedule a flush. Sync and non-blocking
/// (an `unbounded_send`); callable from any handler after it mutates state.
/// No-op if the scheduler has not been spawned yet (should not happen after
/// setup) or the channel is closed.
///
/// Also bumps `autosave_generation` (before sending) so `has_pending_flush`
/// can tell, synchronously and without touching the channel, whether this
/// mutation has been durably flushed yet — the exit handler relies on this.
pub fn schedule_autosave(state: &AppState) {
    state.autosave_generation.fetch_add(1, Ordering::Relaxed);
    if let Ok(guard) = state.autosave_tx.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(());
        }
    }
}

/// True if a mutation has been scheduled since the last successful flush
/// (periodic or exit-time). Lock-free; safe to call from the sync
/// `RunEvent::Exit` handler to decide whether an exit-time flush is worth
/// doing at all — a clean exit must not pay for a disk write it doesn't need.
pub fn has_pending_flush(state: &AppState) -> bool {
    state.autosave_generation.load(Ordering::Relaxed)
        != state.autosave_flushed_generation.load(Ordering::Relaxed)
}

/// Spawn the background scheduler task and return its sender. Called once from
/// `lib.rs` setup (which owns the `AppHandle`). The sender is stored in
/// `AppState::autosave_tx`.
pub fn spawn_scheduler(app: AppHandle) -> UnboundedSender<()> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    tauri::async_runtime::spawn(scheduler_loop(app, rx));
    tx
}

// ---------------------------------------------------------------------------
// Scheduler loop + debounce
// ---------------------------------------------------------------------------

async fn scheduler_loop(app: AppHandle, mut rx: UnboundedReceiver<()>) {
    while rx.recv().await.is_some() {
        debounce(&mut rx, DEBOUNCE_MS).await;
        flush(&app).await;
    }
}

/// Wait for `ms` of quiet on `rx`, draining (and restarting the window on) any
/// further signals that arrive. Returns when no signal arrives within the
/// window, or the channel closes.
async fn debounce(rx: &mut UnboundedReceiver<()>, ms: u64) {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(ms)) => break,
            recv = rx.recv() => {
                if recv.is_none() {
                    break; // channel closed
                }
                // another signal arrived — restart the quiet window
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/// Resolve the `.ltw` destination for a flush: the explicit `ltw_path` when the
/// workspace has one, else the id-keyed `workspaces/{id}.ltw`.
pub fn flush_dest(envelope: &WorkspaceEnvelope, ws_dir: &Path) -> PathBuf {
    match envelope.ltw_path.as_deref() {
        Some(p) => PathBuf::from(p),
        None => ws_dir.join(format!("{}.ltw", envelope.workspace_id)),
    }
}

async fn flush(app: &AppHandle) {
    let state = app.state::<AppState>();

    // Captured before any of the snapshot work below, so that a mutation
    // racing this flush (landing after the snapshot but before completion)
    // is correctly left "dirty" — see `has_pending_flush`.
    let generation_at_start = state.autosave_generation.load(Ordering::Relaxed);

    // (a) Clone the envelope under a brief lock, then drop the guard. No
    //     envelope → log and skip. NEVER fabricate a partial one: writing empty
    //     editor tabs over a good file would destroy user notes.
    let envelope = {
        let Ok(guard) = state.workspace_envelope.lock() else {
            log::warn!("[autosave] workspace_envelope lock poisoned; skipping flush");
            return;
        };
        match guard.as_ref() {
            Some(e) => e.clone(),
            None => {
                log::debug!("[autosave] flush skipped: no workspace envelope cached yet");
                return;
            }
        }
    };

    // (b) Snapshot sessions + artifacts (already lock-disciplined).
    let entries = match collect_session_data(&state) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[autosave] flush skipped: collect_session_data failed: {e}");
            return;
        }
    };

    // Resolve paths (these need the AppHandle) before handing owned data to the
    // blocking pool.
    let ws_dir = match crate::workspace::workspace_dir(app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[autosave] flush skipped: {e}");
            return;
        }
    };
    let app_state_path = match crate::workspace::app_state::app_state_path(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[autosave] flush skipped: {e}");
            return;
        }
    };
    let dest = flush_dest(&envelope, &ws_dir);

    let ltw_lock = state.ltw_write_lock.clone();
    let as_lock = state.app_state_write_lock.clone();
    let workspace_id = envelope.workspace_id.clone();

    // (c,d,f) Sync file I/O on the blocking pool.
    let join = tokio::task::spawn_blocking(move || {
        write_flush_blocking(
            &dest,
            &ws_dir,
            &app_state_path,
            &envelope,
            &entries,
            &ltw_lock,
            &as_lock,
            EVICT_KEEP,
        )
        .map(|saved_at| (dest, saved_at))
    });

    match join.await {
        // (e) Emit so the frontend records the recovery path + timestamp.
        Ok(Ok((path, saved_at))) => {
            state
                .autosave_flushed_generation
                .store(generation_at_start, Ordering::Relaxed);
            let _ = app.emit(
                "workspace-auto-saved",
                serde_json::json!({
                    "workspaceId": workspace_id,
                    "path": path.to_string_lossy(),
                    "savedAt": saved_at,
                }),
            );
            log::info!(
                "[autosave] flushed workspace {workspace_id} to {}",
                path.display()
            );
        }
        Ok(Err(e)) => log::warn!("[autosave] flush write failed: {e}"),
        Err(e) => log::warn!("[autosave] flush task join error: {e}"),
    }
}

/// Synchronous counterpart to `flush()`, for the `RunEvent::Exit` handler.
///
/// By the time `RunEvent::Exit` fires the async scheduler's debounce window
/// (and the tokio runtime driving it) is on its way out, so there is no
/// `.await` or `spawn_blocking` to lean on — everything here runs inline on
/// the exit-handler's thread. Mirrors `flush()` step for step (same envelope
/// snapshot, same `collect_session_data`, same `write_flush_blocking` core —
/// see the module doc for the lock discipline shared with the command path
/// and the periodic flusher), just without the async offload.
///
/// No-op if nothing is dirty (`has_pending_flush` is false) — a clean exit
/// must not pay for a disk write it doesn't need. Callers should check that
/// first; this function does not re-check it, so it always attempts a flush
/// when called.
pub fn flush_now_blocking(app: &AppHandle) {
    let state = app.state::<AppState>();
    let generation_at_start = state.autosave_generation.load(Ordering::Relaxed);

    let envelope = {
        let Ok(guard) = state.workspace_envelope.lock() else {
            log::warn!("[autosave] exit flush skipped: workspace_envelope lock poisoned");
            return;
        };
        match guard.as_ref() {
            Some(e) => e.clone(),
            None => {
                log::debug!("[autosave] exit flush skipped: no workspace envelope cached yet");
                return;
            }
        }
    };

    let entries = match collect_session_data(&state) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[autosave] exit flush skipped: collect_session_data failed: {e}");
            return;
        }
    };

    let ws_dir = match crate::workspace::workspace_dir(app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[autosave] exit flush skipped: {e}");
            return;
        }
    };
    let app_state_path = match crate::workspace::app_state::app_state_path(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[autosave] exit flush skipped: {e}");
            return;
        }
    };
    let dest = flush_dest(&envelope, &ws_dir);
    let workspace_id = envelope.workspace_id.clone();

    match write_flush_blocking(
        &dest,
        &ws_dir,
        &app_state_path,
        &envelope,
        &entries,
        &state.ltw_write_lock,
        &state.app_state_write_lock,
        EVICT_KEEP,
    ) {
        Ok(_saved_at) => {
            state
                .autosave_flushed_generation
                .store(generation_at_start, Ordering::Relaxed);
            log::info!(
                "[autosave] exit flush: persisted workspace {workspace_id} to {}",
                dest.display()
            );
        }
        Err(e) => log::warn!("[autosave] exit flush write failed: {e}"),
    }
}

/// Write the merged `.ltw`, record the auto-save into `app-state.json`, and run
/// eviction. Sync (blocking) — call inside `spawn_blocking`. Returns the
/// manifest `saved_at` so the caller can emit it (and so it exactly equals the
/// `last_auto_save_at` written to `app-state.json`, which Q3's tolerance check
/// relies on).
///
/// The `.ltw` write is serialised against the command-path writers via
/// `ltw_write_lock`; the `app-state.json` read-modify-write against
/// `save_app_state_cmd` via `app_state_write_lock`. Each lock is held only
/// across its own sync write.
#[allow(clippy::too_many_arguments)]
pub fn write_flush_blocking(
    dest: &Path,
    ws_dir: &Path,
    app_state_path: &Path,
    envelope: &WorkspaceEnvelope,
    entries: &[SessionEntry],
    ltw_write_lock: &Mutex<()>,
    app_state_write_lock: &Mutex<()>,
    keep: usize,
) -> Result<i64, String> {
    let refs = entry_refs(entries);

    let saved_at = {
        // Serialise against save_workspace_v4 / auto_save_workspace writes.
        let _guard = ltw_write_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        ltw_v4::write_ltw(
            dest,
            &envelope.workspace_name,
            Some(&envelope.workspace_id),
            &refs,
            &envelope.pipeline_chain,
            &envelope.editor_tabs,
            envelope.layout.as_ref(),
        )?
    };

    let dest_str = dest.to_string_lossy().to_string();
    record_auto_save_in_app_state(
        app_state_path,
        &envelope.workspace_id,
        &dest_str,
        saved_at,
        app_state_write_lock,
    )?;

    crate::workspace::evict_old_workspaces(ws_dir, keep);

    Ok(saved_at)
}

/// Read-modify-write `app-state.json`: set `auto_save_path` / `last_auto_save_at`
/// on the entry whose `id == workspace_id`, preserving every other entry. Does
/// nothing (returns `Ok(false)`) if no such entry exists — the workspace list is
/// authoritative, so a flush must never resurrect a removed workspace.
///
/// Serialised against `save_app_state_cmd` via `write_lock` so the two writers
/// never tear the file (a corrupt `app-state.json` parses as the empty default,
/// which would silently drop the whole workspace list).
pub fn record_auto_save_in_app_state(
    app_state_path: &Path,
    workspace_id: &str,
    auto_save_path: &str,
    saved_at: i64,
    write_lock: &Mutex<()>,
) -> Result<bool, String> {
    let _guard = write_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    let mut state = load_app_state(app_state_path);
    let Some(entry) = state.workspaces.iter_mut().find(|w| w.id == workspace_id) else {
        log::warn!(
            "[autosave] workspace {workspace_id} not in app-state.json; skipping record"
        );
        return Ok(false);
    };
    entry.auto_save_path = Some(auto_save_path.to_string());
    entry.last_auto_save_at = Some(saved_at);
    save_app_state(app_state_path, &state)?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::app_state::{AppStateFile, WorkspaceEntry};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::mpsc::unbounded_channel;

    fn envelope(id: &str, ltw_path: Option<&str>) -> WorkspaceEnvelope {
        WorkspaceEnvelope {
            workspace_id: id.to_string(),
            workspace_name: format!("ws-{id}"),
            ltw_path: ltw_path.map(str::to_string),
            editor_tabs: vec![],
            layout: None,
            pipeline_chain: LtwPipelineChain::default(),
            updated_at: 0,
        }
    }

    // Mirror of scheduler_loop, counting flushes instead of performing them, so
    // the debounce timing can be exercised under tokio::time::pause().
    async fn run_counting(
        mut rx: UnboundedReceiver<()>,
        debounce_ms: u64,
        counter: Arc<AtomicUsize>,
    ) {
        while rx.recv().await.is_some() {
            debounce(&mut rx, debounce_ms).await;
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }

    // --- Debounce ---------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn rapid_schedules_collapse_to_one_flush() {
        let (tx, rx) = unbounded_channel();
        for _ in 0..5 {
            tx.send(()).unwrap();
        }
        drop(tx); // close so the loop terminates after draining the burst
        let count = Arc::new(AtomicUsize::new(0));
        run_counting(rx, DEBOUNCE_MS, count.clone()).await;
        assert_eq!(count.load(Ordering::SeqCst), 1, "5 rapid schedules → 1 flush");
    }

    #[tokio::test(start_paused = true)]
    async fn separated_bursts_flush_once_each() {
        let (tx, rx) = unbounded_channel();
        let count = Arc::new(AtomicUsize::new(0));
        let handle = tokio::spawn(run_counting(rx, DEBOUNCE_MS, count.clone()));

        // First burst of two → one flush after the quiet window.
        tx.send(()).unwrap();
        tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS + 500)).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);

        // A later, well-separated signal → a second flush.
        tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS + 500)).await;
        assert_eq!(count.load(Ordering::SeqCst), 2);

        drop(tx);
        handle.await.unwrap();
    }

    // --- Exit-flush dirty tracking (Q5) ------------------------------------
    //
    // `flush_now_blocking` itself needs a real `AppHandle` (no mock-app
    // pattern exists in this codebase), so it can only be exercised via the
    // full Tauri app runtime. What's unit-testable — and is the actual new
    // logic this fix adds — is the generation-counter dirty tracking that
    // `has_pending_flush` / `schedule_autosave` share with `flush()` and
    // `flush_now_blocking`. These tests drive that bookkeeping directly.

    #[test]
    fn has_pending_flush_false_on_fresh_state() {
        let state = AppState::new();
        assert!(!has_pending_flush(&state), "nothing scheduled yet → not dirty");
    }

    #[test]
    fn schedule_autosave_marks_dirty_until_flushed_generation_catches_up() {
        let state = AppState::new();
        assert!(!has_pending_flush(&state));

        schedule_autosave(&state);
        assert!(has_pending_flush(&state), "a scheduled mutation must read as dirty");

        // Mirrors what a successful flush() / flush_now_blocking() does on
        // success: record the generation it captured at the start.
        let generation = state.autosave_generation.load(Ordering::Relaxed);
        state.autosave_flushed_generation.store(generation, Ordering::Relaxed);
        assert!(!has_pending_flush(&state), "recording the flushed generation clears dirty");
    }

    #[test]
    fn mutation_racing_an_in_flight_flush_stays_dirty() {
        let state = AppState::new();

        // A flush begins and captures "nothing pending yet" at this instant...
        let generation_at_flush_start = state.autosave_generation.load(Ordering::Relaxed);

        // ...but another mutation is scheduled before that flush completes.
        schedule_autosave(&state);

        // The in-flight flush finishes and records the *stale* generation it
        // captured at start (exactly what flush()/flush_now_blocking() do) —
        // never the current one, since it never saw the later mutation.
        state
            .autosave_flushed_generation
            .store(generation_at_flush_start, Ordering::Relaxed);

        assert!(
            has_pending_flush(&state),
            "a mutation racing an in-flight flush must not be silently marked clean"
        );
    }

    #[test]
    fn repeated_schedules_between_flushes_stay_dirty_until_recorded() {
        let state = AppState::new();

        schedule_autosave(&state);
        schedule_autosave(&state);
        schedule_autosave(&state);
        assert!(has_pending_flush(&state));

        let generation = state.autosave_generation.load(Ordering::Relaxed);
        state.autosave_flushed_generation.store(generation, Ordering::Relaxed);
        assert!(!has_pending_flush(&state));

        // A later, independent mutation must be picked up again.
        schedule_autosave(&state);
        assert!(has_pending_flush(&state));
    }

    // --- flush_dest -------------------------------------------------------

    #[test]
    fn flush_dest_uses_id_keyed_path_when_ltw_path_none() {
        let dir = tempdir().unwrap();
        let env = envelope("ws-1", None);
        assert_eq!(flush_dest(&env, dir.path()), dir.path().join("ws-1.ltw"));
    }

    #[test]
    fn flush_dest_uses_explicit_path_when_present() {
        let dir = tempdir().unwrap();
        let env = envelope("ws-1", Some("/user/chosen/debug.ltw"));
        assert_eq!(flush_dest(&env, dir.path()), PathBuf::from("/user/chosen/debug.ltw"));
    }

    // --- write_flush_blocking (integration against a real temp dir) -------

    #[test]
    fn write_flush_writes_id_keyed_ltw_and_records_app_state() {
        let dir = tempdir().unwrap();
        let ws_dir = dir.path().join("workspaces");
        std::fs::create_dir_all(&ws_dir).unwrap();
        let app_state_path = dir.path().join("app-state.json");

        // Seed app-state.json with the target entry plus one to preserve.
        let seed = AppStateFile {
            workspaces: vec![
                WorkspaceEntry {
                    id: "ws-1".into(),
                    name: "Untitled".into(),
                    ltw_path: None,
                    dirty: true,
                    auto_save_path: None,
                    last_auto_save_at: None,
                },
                WorkspaceEntry {
                    id: "ws-2".into(),
                    name: "Other".into(),
                    ltw_path: Some("/other.ltw".into()),
                    dirty: false,
                    auto_save_path: None,
                    last_auto_save_at: None,
                },
            ],
            active_workspace_id: Some("ws-1".into()),
        };
        save_app_state(&app_state_path, &seed).unwrap();

        let env = envelope("ws-1", None);
        let dest = flush_dest(&env, &ws_dir);
        let ltw_lock = Mutex::new(());
        let as_lock = Mutex::new(());

        let saved_at =
            write_flush_blocking(&dest, &ws_dir, &app_state_path, &env, &[], &ltw_lock, &as_lock, EVICT_KEEP)
                .unwrap();

        // .ltw written at the id-keyed path and readable.
        assert!(dest.exists());
        let data = ltw_v4::read_ltw(&dest).unwrap();
        assert_eq!(data.manifest.workspace_name, "ws-ws-1");
        assert_eq!(data.manifest.saved_at, saved_at);
        // The flusher stamps the envelope's workspace id into the manifest so
        // Q3's trust gate can match it against the app-state entry on restore.
        assert_eq!(data.manifest.workspace_id.as_deref(), Some("ws-1"));

        // app-state.json: target entry updated, other entry preserved.
        let reloaded = load_app_state(&app_state_path);
        let ws1 = reloaded.workspaces.iter().find(|w| w.id == "ws-1").unwrap();
        assert_eq!(ws1.auto_save_path.as_deref(), Some(dest.to_string_lossy().as_ref()));
        assert_eq!(ws1.last_auto_save_at, Some(saved_at));
        let ws2 = reloaded.workspaces.iter().find(|w| w.id == "ws-2").unwrap();
        assert_eq!(ws2.name, "Other");
        assert_eq!(ws2.ltw_path.as_deref(), Some("/other.ltw"));
        assert!(ws2.auto_save_path.is_none(), "unrelated entry must be untouched");
    }

    #[test]
    fn record_auto_save_preserves_other_entries() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("app-state.json");
        let seed = AppStateFile {
            workspaces: vec![
                WorkspaceEntry { id: "a".into(), name: "A".into(), ltw_path: None, dirty: false, auto_save_path: None, last_auto_save_at: None },
                WorkspaceEntry { id: "b".into(), name: "B".into(), ltw_path: None, dirty: true,  auto_save_path: None, last_auto_save_at: None },
                WorkspaceEntry { id: "c".into(), name: "C".into(), ltw_path: Some("/c.ltw".into()), dirty: false, auto_save_path: None, last_auto_save_at: None },
            ],
            active_workspace_id: Some("b".into()),
        };
        save_app_state(&path, &seed).unwrap();

        let lock = Mutex::new(());
        let updated = record_auto_save_in_app_state(&path, "b", "/data/workspaces/b.ltw", 1_700_000_000_000, &lock).unwrap();
        assert!(updated);

        let reloaded = load_app_state(&path);
        assert_eq!(reloaded.workspaces.len(), 3);
        let b = reloaded.workspaces.iter().find(|w| w.id == "b").unwrap();
        assert_eq!(b.auto_save_path.as_deref(), Some("/data/workspaces/b.ltw"));
        assert_eq!(b.last_auto_save_at, Some(1_700_000_000_000));
        // Others untouched.
        let a = reloaded.workspaces.iter().find(|w| w.id == "a").unwrap();
        assert!(a.auto_save_path.is_none() && a.last_auto_save_at.is_none());
        let c = reloaded.workspaces.iter().find(|w| w.id == "c").unwrap();
        assert_eq!(c.ltw_path.as_deref(), Some("/c.ltw"));
        assert_eq!(reloaded.active_workspace_id.as_deref(), Some("b"));
    }

    #[test]
    fn record_auto_save_skips_when_entry_absent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("app-state.json");
        let seed = AppStateFile {
            workspaces: vec![WorkspaceEntry { id: "a".into(), name: "A".into(), ltw_path: None, dirty: false, auto_save_path: None, last_auto_save_at: None }],
            active_workspace_id: Some("a".into()),
        };
        save_app_state(&path, &seed).unwrap();

        let lock = Mutex::new(());
        let updated = record_auto_save_in_app_state(&path, "does-not-exist", "/x.ltw", 1, &lock).unwrap();
        assert!(!updated, "absent workspace id must not be created");
        let reloaded = load_app_state(&path);
        assert_eq!(reloaded.workspaces.len(), 1);
        assert!(reloaded.workspaces[0].auto_save_path.is_none());
    }

    #[test]
    fn write_flush_runs_eviction() {
        let dir = tempdir().unwrap();
        let ws_dir = dir.path().join("workspaces");
        std::fs::create_dir_all(&ws_dir).unwrap();
        let app_state_path = dir.path().join("app-state.json");
        save_app_state(&app_state_path, &AppStateFile::default()).unwrap();

        // Pre-populate KEEP older .ltw files so the flush's own write pushes the
        // count to KEEP+1 and eviction trims back to KEEP.
        for i in 0..EVICT_KEEP {
            std::fs::write(ws_dir.join(format!("old-{i}.ltw")), b"x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let env = envelope("fresh", None);
        let dest = flush_dest(&env, &ws_dir);
        let ltw_lock = Mutex::new(());
        let as_lock = Mutex::new(());
        write_flush_blocking(&dest, &ws_dir, &app_state_path, &env, &[], &ltw_lock, &as_lock, EVICT_KEEP).unwrap();

        let ltw_count = std::fs::read_dir(&ws_dir).unwrap().flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "ltw")).count();
        assert_eq!(ltw_count, EVICT_KEEP, "eviction must trim to KEEP files");
        assert!(dest.exists(), "the freshly-written file (newest) must survive eviction");
    }

    /// Concurrent flush writes to the same dest never tear the file, because
    /// `ltw_write_lock` serialises them — models a flush racing an in-flight
    /// `save_workspace_v4` on the same path.
    #[test]
    fn concurrent_writes_serialize_via_write_lock() {
        let dir = tempdir().unwrap();
        let ws_dir = dir.path().join("workspaces");
        std::fs::create_dir_all(&ws_dir).unwrap();
        let app_state_path = dir.path().join("app-state.json");
        save_app_state(&app_state_path, &AppStateFile::default()).unwrap();

        let ltw_lock = Arc::new(Mutex::new(()));
        let as_lock = Arc::new(Mutex::new(()));
        let env = Arc::new(envelope("shared", None));
        let dest = flush_dest(&env, &ws_dir);

        let mut handles = vec![];
        for _ in 0..8 {
            let (ws_dir, app_state_path, dest) = (ws_dir.clone(), app_state_path.clone(), dest.clone());
            let (ltw_lock, as_lock, env) = (ltw_lock.clone(), as_lock.clone(), env.clone());
            handles.push(std::thread::spawn(move || {
                write_flush_blocking(&dest, &ws_dir, &app_state_path, &env, &[], &ltw_lock, &as_lock, EVICT_KEEP)
            }));
        }
        for h in handles {
            h.join().unwrap().unwrap();
        }
        // If any two writes had interleaved, the zip would be corrupt.
        assert!(ltw_v4::read_ltw(&dest).is_ok(), "serialised writes leave a valid .ltw");
    }
}
