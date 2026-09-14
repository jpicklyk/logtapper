//! Per-session processor chain — the analyzers the user sees in the Analyzers
//! panel, and what a chain-only `run_pipeline` executes.
//!
//! The chain lives in `AppState::session_pipeline_meta` and used to have
//! exactly one writer: the frontend's `set_session_pipeline_meta` command, a
//! bare map insert. An agent's `run_pipeline(processor_ids)` ran processors
//! the chain never learned about, so the next human "Run" silently excluded
//! whatever the agent had chosen. This module is the single mutation surface
//! for both transports: every change lands in the same map, is broadcast as
//! [`CHAIN_UPDATE_EVENT`] with the caller stamped on it, schedules an autosave
//! flush, and — when membership or enablement actually changed — journals
//! `chain.update` so the activity feed shows who did it.
//!
//! ## Shape
//!
//! `active_processor_ids` is the **full ordered chain**, disabled members
//! included; `disabled_processor_ids` is the subset that is switched off. That
//! is the contract `services::pipeline::resolve_effective_chain` (`active −
//! disabled`) and the `.ltw` save format already use. [`PII_ANONYMIZER_ID`] is
//! never stored — it is force-included per caller by `resolve_effective_chain`
//! and must not be something a chain edit can add or remove.
//!
//! ## Lenient vs strict id resolution
//!
//! [`set`] is **lenient**: an id containing `@` is stored as given, without
//! checking that it is installed. The UI's own chain legitimately carries
//! `@lts-` workspace-local processors and ids whose processor was just
//! uninstalled (`resolve_effective_chain` tolerates both when it runs), so a
//! full replace from the UI must not fail on them. A *bare* id is still
//! resolved (`wifi` → `wifi@official`) and an unknown bare id is an
//! `InvalidArg`. [`patch`]'s `add` is **strict**: every id must resolve to an
//! installed processor, because an agent adding something that does not
//! exist is a mistake worth surfacing, not a chain entry worth keeping.
//! `remove` accepts anything currently in the chain verbatim (so a stale or
//! `@lts-` entry the caller read back from [`get`] can always be removed) and
//! otherwise resolves strictly.
//!
//! ## Locks
//!
//! One `AppState` lock at a time, in the order `sessions` (does the session
//! exist) → `processors` (resolve ids) → `session_pipeline_meta` (compare and
//! store). The event, autosave and journal all happen after the last guard is
//! dropped. Two writers deliberately stay outside this module:
//! `services::sessions`'s workspace-restore paths write the map directly
//! (restore is not a caller action, autosave is suppressed there, and the
//! restored ids may no longer be installed), and session close removes the
//! entry.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::processors::marketplace::resolve_processor_id_checked;
use crate::workspace::autosave::schedule_autosave;
use crate::workspace::SessionMeta;

use super::pipeline::PII_ANONYMIZER_ID;
use super::{lock_svc, Caller, ServiceCtx, ServiceError};

/// Event name for [`ChainUpdateEvent`].
pub const CHAIN_UPDATE_EVENT: &str = "chain-update";

/// A session's chain as stored and returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChainState {
    pub session_id: String,
    /// The full ordered chain, disabled members included.
    pub active_processor_ids: Vec<String>,
    /// The subset of `active_processor_ids` that is switched off.
    pub disabled_processor_ids: Vec<String>,
}

/// Broadcast as [`CHAIN_UPDATE_EVENT`] after every chain change, from either
/// transport. Carries the whole new chain (not a delta) so a listener applies
/// it as a replace, plus who made the change — a UI store uses `caller` to
/// ignore the echo of its own writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChainUpdateEvent {
    pub session_id: String,
    pub active_processor_ids: Vec<String>,
    pub disabled_processor_ids: Vec<String>,
    pub caller: Caller,
}

/// Read a session's chain. `NotFound` for an unknown session; a session with
/// no chain yet reads as empty rather than erroring.
pub fn get(ctx: &ServiceCtx, session_id: &str) -> Result<ChainState, ServiceError> {
    ensure_session(ctx, session_id)?;
    let meta = lock_svc(&ctx.state().session_pipeline_meta, "session_pipeline_meta")?
        .get(session_id)
        .cloned()
        .unwrap_or_default();
    Ok(ChainState {
        session_id: session_id.to_string(),
        active_processor_ids: meta.active_processor_ids,
        disabled_processor_ids: meta.disabled_processor_ids,
    })
}

/// Replace a session's chain wholesale. Lenient about qualified ids (see the
/// module docs); a disabled id that is not in `active` is dropped rather than
/// rejected, so the stored `disabled` is always a subset of `active`.
pub fn set(
    ctx: &ServiceCtx,
    session_id: &str,
    active_processor_ids: Vec<String>,
    disabled_processor_ids: Vec<String>,
) -> Result<ChainState, ServiceError> {
    ensure_session(ctx, session_id)?;
    let active = resolve_ids(ctx, &active_processor_ids, Resolution::Lenient)?;
    let disabled = resolve_ids(ctx, &disabled_processor_ids, Resolution::Lenient)?;
    let disabled = disabled
        .into_iter()
        .filter(|id| active.contains(id))
        .collect();
    commit(ctx, session_id, active, disabled)
}

/// Add and/or remove chain members without touching the rest. `add` appends
/// ids not already present, in the given order, and re-enables any that were
/// disabled — an explicit add means "I want this to run". `remove` drops ids
/// from both lists.
pub fn patch(
    ctx: &ServiceCtx,
    session_id: &str,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<ChainState, ServiceError> {
    // `get` already checks the session exists — no second `sessions` lock.
    let current = get(ctx, session_id)?;
    let add = resolve_ids(ctx, &add, Resolution::Strict)?;
    let remove = resolve_ids(ctx, &remove, Resolution::StrictOrMember(&current.active_processor_ids))?;

    let removed: HashSet<&str> = remove.iter().map(String::as_str).collect();
    let added: HashSet<&str> = add.iter().map(String::as_str).collect();

    let mut active: Vec<String> = current
        .active_processor_ids
        .into_iter()
        .filter(|id| !removed.contains(id.as_str()))
        .collect();
    for id in &add {
        if !active.contains(id) {
            active.push(id.clone());
        }
    }
    let disabled: Vec<String> = current
        .disabled_processor_ids
        .into_iter()
        .filter(|id| !removed.contains(id.as_str()) && !added.contains(id.as_str()))
        .collect();

    commit(ctx, session_id, active, disabled)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn ensure_session(ctx: &ServiceCtx, session_id: &str) -> Result<(), ServiceError> {
    let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
    if !sessions.contains_key(session_id) {
        return Err(ServiceError::session_not_found(session_id));
    }
    Ok(())
}

/// How [`resolve_ids`] treats an id that is not an installed processor.
#[derive(Clone, Copy)]
enum Resolution<'a> {
    /// A qualified id (`contains('@')`) passes through unresolved; a bare id
    /// must resolve.
    Lenient,
    /// Every id must resolve to an installed processor.
    Strict,
    /// Like [`Resolution::Strict`], except an id that is verbatim one of the
    /// given chain members passes through — for `remove`, so a stale entry
    /// read back from [`get`] can always be removed.
    StrictOrMember(&'a [String]),
}

/// Resolve bare ids to qualified ones, drop the anonymizer, dedup preserving
/// first occurrence. Holds only the `processors` lock.
fn resolve_ids(
    ctx: &ServiceCtx,
    ids: &[String],
    mode: Resolution<'_>,
) -> Result<Vec<String>, ServiceError> {
    let procs = lock_svc(&ctx.state().processors, "processors")?;
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        if id == PII_ANONYMIZER_ID {
            continue;
        }
        let pass_through = match mode {
            Resolution::Lenient => id.contains('@'),
            Resolution::Strict => false,
            Resolution::StrictOrMember(members) => members.contains(id),
        };
        let resolved = if pass_through {
            id.clone()
        } else {
            match resolve_processor_id_checked(&procs, id) {
                Ok(Some(qualified)) => qualified,
                Ok(None) => {
                    return Err(ServiceError::invalid_arg(format!(
                        "processor '{id}' is not installed"
                    )))
                }
                Err(e) => return Err(ServiceError::invalid_arg(e)),
            }
        };
        // The anonymizer is installed under its bare id, so a bare-id resolve
        // can only yield it if the input already was it — checked above — but
        // the stored invariant is cheap to pin here too.
        if resolved == PII_ANONYMIZER_ID || out.contains(&resolved) {
            continue;
        }
        out.push(resolved);
    }
    Ok(out)
}

/// Store the new chain if it differs from what is stored, then emit, autosave
/// and (when membership or enablement changed) journal. A pure reorder emits
/// and autosaves but does not journal — the feed should not fill with
/// move-up/move-down noise. An unchanged chain does nothing at all.
fn commit(
    ctx: &ServiceCtx,
    session_id: &str,
    active: Vec<String>,
    disabled: Vec<String>,
) -> Result<ChainState, ServiceError> {
    let previous = {
        let mut map = lock_svc(&ctx.state().session_pipeline_meta, "session_pipeline_meta")?;
        let previous = map.get(session_id).cloned().unwrap_or_default();
        if previous.active_processor_ids == active && previous.disabled_processor_ids == disabled {
            return Ok(ChainState {
                session_id: session_id.to_string(),
                active_processor_ids: active,
                disabled_processor_ids: disabled,
            });
        }
        map.insert(
            session_id.to_string(),
            SessionMeta {
                active_processor_ids: active.clone(),
                disabled_processor_ids: disabled.clone(),
            },
        );
        previous
    };

    ctx.events().emit_json(
        CHAIN_UPDATE_EVENT,
        serde_json::to_value(ChainUpdateEvent {
            session_id: session_id.to_string(),
            active_processor_ids: active.clone(),
            disabled_processor_ids: disabled.clone(),
            caller: ctx.caller().clone(),
        })
        .unwrap_or_default(),
    );
    schedule_autosave(ctx.state());

    if let Some(summary) = describe_change(&previous, &active, &disabled) {
        ctx.journal("chain.update", Some(session_id), summary);
    }

    Ok(ChainState {
        session_id: session_id.to_string(),
        active_processor_ids: active,
        disabled_processor_ids: disabled,
    })
}

/// A one-line summary of what changed between `previous` and the new chain,
/// or `None` when only the order differs.
fn describe_change(previous: &SessionMeta, active: &[String], disabled: &[String]) -> Option<String> {
    let was_active: HashSet<&str> = previous.active_processor_ids.iter().map(String::as_str).collect();
    let was_disabled: HashSet<&str> = previous.disabled_processor_ids.iter().map(String::as_str).collect();
    let now_active: HashSet<&str> = active.iter().map(String::as_str).collect();
    let now_disabled: HashSet<&str> = disabled.iter().map(String::as_str).collect();

    let mut parts: Vec<String> = Vec::new();
    for id in active.iter().filter(|id| !was_active.contains(id.as_str())) {
        parts.push(format!("+{id}"));
    }
    for id in previous
        .active_processor_ids
        .iter()
        .filter(|id| !now_active.contains(id.as_str()))
    {
        parts.push(format!("-{id}"));
    }
    // Enablement flips only count for ids that were already members — a
    // newly added id is reported by its `+` alone.
    for id in disabled
        .iter()
        .filter(|id| was_active.contains(id.as_str()) && !was_disabled.contains(id.as_str()))
    {
        parts.push(format!("disabled {id}"));
    }
    for id in previous
        .disabled_processor_ids
        .iter()
        .filter(|id| now_active.contains(id.as_str()) && !now_disabled.contains(id.as_str()))
    {
        parts.push(format!("enabled {id}"));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processors::AnyProcessor;
    use crate::services::testing::test_ctx;

    const REPORTER_YAML: &str = r#"
meta:
  id: r
  name: R
pipeline:
  - stage: filter
    rules:
      - type: message_contains
        value: "x"
"#;

    fn install(ctx: &ServiceCtx, id: &str) {
        let proc = AnyProcessor::from_yaml(REPORTER_YAML).expect("fixture yaml parses");
        ctx.state()
            .processors
            .lock()
            .unwrap()
            .insert(id.to_string(), proc);
    }

    fn stored(ctx: &ServiceCtx, session_id: &str) -> SessionMeta {
        ctx.state()
            .session_pipeline_meta
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    fn strs(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    // ── get ────────────────────────────────────────────────────────────────

    #[test]
    fn get_on_an_unknown_session_is_not_found() {
        let (ctx, _t) = test_ctx().build();
        let err = get(&ctx, "ghost").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
        assert_eq!(err.message(), "Session 'ghost' not found");
    }

    #[test]
    fn get_with_no_chain_yet_reads_as_empty() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        let state = get(&ctx, "s1").expect("get");
        assert_eq!(state.session_id, "s1");
        assert!(state.active_processor_ids.is_empty());
        assert!(state.disabled_processor_ids.is_empty());
    }

    // ── set ────────────────────────────────────────────────────────────────

    #[test]
    fn set_resolves_bare_ids_and_passes_qualified_ids_through() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "wifi@official");

        let state = set(&ctx, "s1", strs(&["wifi", "x@lts-abc"]), vec![]).expect("set");
        assert_eq!(state.active_processor_ids, strs(&["wifi@official", "x@lts-abc"]));
        assert_eq!(
            stored(&ctx, "s1").active_processor_ids,
            strs(&["wifi@official", "x@lts-abc"]),
            "the resolved chain is what gets stored"
        );
    }

    #[test]
    fn set_rejects_an_unknown_bare_id() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        let err = set(&ctx, "s1", strs(&["nope"]), vec![]).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(err.message().contains("nope"), "{}", err.message());
    }

    #[test]
    fn set_on_an_unknown_session_is_not_found() {
        let (ctx, _t) = test_ctx().build();
        let err = set(&ctx, "ghost", vec![], vec![]).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn set_never_stores_the_anonymizer_and_dedups() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 1).build_recording();
        install(&ctx, "a@official");
        install(&ctx, PII_ANONYMIZER_ID);

        let state = set(
            &ctx,
            "s1",
            strs(&["a", PII_ANONYMIZER_ID, "a@official", "a"]),
            strs(&[PII_ANONYMIZER_ID]),
        )
        .expect("set");
        assert_eq!(state.active_processor_ids, strs(&["a@official"]));
        assert!(state.disabled_processor_ids.is_empty());
        let payload = sink.only_event(CHAIN_UPDATE_EVENT);
        assert_eq!(payload["activeProcessorIds"], serde_json::json!(["a@official"]));
    }

    #[test]
    fn set_drops_a_disabled_id_that_is_not_in_the_chain() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official");
        install(&ctx, "b@official");
        let state = set(&ctx, "s1", strs(&["a"]), strs(&["b", "a"])).expect("set");
        assert_eq!(state.disabled_processor_ids, strs(&["a@official"]));
    }

    // ── patch ──────────────────────────────────────────────────────────────

    #[test]
    fn patch_add_is_strict_about_unknown_ids() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 1).build_recording();
        let err = patch(&ctx, "s1", strs(&["nope"]), vec![]).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
        assert!(sink.is_empty(), "a rejected patch must not emit");
    }

    #[test]
    fn patch_add_rejects_a_qualified_id_that_is_not_installed() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        let err = patch(&ctx, "s1", strs(&["x@lts-abc"]), vec![]).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn patch_appends_missing_ids_in_order_and_re_enables_them() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official");
        install(&ctx, "b@official");
        install(&ctx, "c@official");
        set(&ctx, "s1", strs(&["a", "b"]), strs(&["b"])).expect("seed");

        let state = patch(&ctx, "s1", strs(&["c", "b", "a"]), vec![]).expect("patch");
        assert_eq!(
            state.active_processor_ids,
            strs(&["a@official", "b@official", "c@official"]),
            "existing members keep their position; new ones append in the given order"
        );
        assert!(
            state.disabled_processor_ids.is_empty(),
            "an explicit add re-enables a disabled member"
        );
    }

    #[test]
    fn patch_with_an_id_in_both_add_and_remove_lets_add_win() {
        // `remove` filters first, then `add` re-appends whatever is missing —
        // so a contradictory request lands the id present and enabled. An
        // explicit add means "I want this to run", and that is the final word.
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official");
        install(&ctx, "b@official");
        set(&ctx, "s1", strs(&["a", "b"]), strs(&["b"])).expect("seed");

        let state = patch(&ctx, "s1", strs(&["b"]), strs(&["b"])).expect("patch");
        assert_eq!(
            state.active_processor_ids,
            strs(&["a@official", "b@official"]),
            "the id is removed then re-added, so it moves to the tail"
        );
        assert!(state.disabled_processor_ids.is_empty(), "the add re-enables it");
    }

    #[test]
    fn patch_remove_drops_from_both_lists_and_accepts_a_stale_member_verbatim() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        install(&ctx, "a@official");
        install(&ctx, "b@official");
        set(&ctx, "s1", strs(&["a", "b", "gone@lts-old"]), strs(&["b", "gone@lts-old"])).expect("seed");

        let state = patch(&ctx, "s1", vec![], strs(&["b", "gone@lts-old"])).expect("patch");
        assert_eq!(state.active_processor_ids, strs(&["a@official"]));
        assert!(state.disabled_processor_ids.is_empty());
    }

    #[test]
    fn patch_remove_of_an_unknown_non_member_is_invalid() {
        let (ctx, _t) = test_ctx().with_session("s1", 1).build();
        let err = patch(&ctx, "s1", vec![], strs(&["nope"])).unwrap_err();
        assert_eq!(err.code(), "INVALID_ARGUMENT");
    }

    #[test]
    fn patch_on_an_unknown_session_is_not_found() {
        let (ctx, _t) = test_ctx().build();
        let err = patch(&ctx, "ghost", vec![], vec![]).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    // ── commit: event / autosave / journal discipline ──────────────────────

    #[test]
    fn a_no_op_set_or_patch_emits_nothing_and_journals_nothing() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 1).build_recording();
        install(&ctx, "a@official");
        set(&ctx, "s1", strs(&["a"]), vec![]).expect("seed");
        sink.clear();
        let gen_before = ctx.state().autosave_generation.load(std::sync::atomic::Ordering::Relaxed);

        set(&ctx, "s1", strs(&["a@official"]), vec![]).expect("same chain again");
        patch(&ctx, "s1", strs(&["a"]), vec![]).expect("already a member");
        patch(&ctx, "s1", vec![], vec![]).expect("empty patch");

        assert!(sink.is_empty(), "unchanged chain must emit nothing: {:?}", sink.events());
        assert_eq!(ctx.state().activity.len(), 1, "only the seed journaled");
        assert_eq!(
            ctx.state().autosave_generation.load(std::sync::atomic::Ordering::Relaxed),
            gen_before,
            "unchanged chain must not schedule an autosave"
        );
    }

    #[test]
    fn a_reorder_only_set_emits_and_autosaves_but_does_not_journal() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 1).build_recording();
        install(&ctx, "a@official");
        install(&ctx, "b@official");
        set(&ctx, "s1", strs(&["a", "b"]), vec![]).expect("seed");
        sink.clear();
        let gen_before = ctx.state().autosave_generation.load(std::sync::atomic::Ordering::Relaxed);

        let state = set(&ctx, "s1", strs(&["b", "a"]), vec![]).expect("reorder");
        assert_eq!(state.active_processor_ids, strs(&["b@official", "a@official"]));

        let payload = sink.only_event(CHAIN_UPDATE_EVENT);
        assert_eq!(payload["activeProcessorIds"], serde_json::json!(["b@official", "a@official"]));
        assert!(sink.events_named("activity").is_empty(), "a pure reorder is not feed-worthy");
        assert_eq!(ctx.state().activity.len(), 1, "only the seed journaled");
        assert!(
            ctx.state().autosave_generation.load(std::sync::atomic::Ordering::Relaxed) > gen_before,
            "a reorder still needs persisting"
        );
    }

    #[test]
    fn an_agent_add_journals_chain_update_with_the_agent_caller_in_the_event() {
        let (ctx, sink, _t) = test_ctx()
            .agent("claude")
            .with_session("s1", 1)
            .build_recording();
        install(&ctx, "wifi@official");

        patch(&ctx, "s1", strs(&["wifi"]), vec![]).expect("patch");

        let payload = sink.only_event(CHAIN_UPDATE_EVENT);
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["activeProcessorIds"], serde_json::json!(["wifi@official"]));
        assert_eq!(payload["disabledProcessorIds"], serde_json::json!([]));
        assert_eq!(payload["caller"], serde_json::json!({ "kind": "agent", "client": "claude" }));

        let entry = sink.only_event("activity");
        assert_eq!(entry["action"], "chain.update");
        assert_eq!(entry["sessionId"], "s1");
        assert_eq!(entry["caller"]["kind"], "agent");
        assert_eq!(entry["summary"], "+wifi@official");
    }

    #[test]
    fn an_enablement_flip_journals_even_though_membership_is_unchanged() {
        let (ctx, sink, _t) = test_ctx().with_session("s1", 1).build_recording();
        install(&ctx, "a@official");
        set(&ctx, "s1", strs(&["a"]), vec![]).expect("seed");
        sink.clear();

        set(&ctx, "s1", strs(&["a"]), strs(&["a"])).expect("disable");
        assert_eq!(sink.only_event("activity")["summary"], "disabled a@official");
        sink.clear();

        set(&ctx, "s1", strs(&["a"]), vec![]).expect("enable");
        assert_eq!(sink.only_event("activity")["summary"], "enabled a@official");
    }

    #[test]
    fn describe_change_reports_removals_and_ignores_enablement_of_new_members() {
        let previous = SessionMeta {
            active_processor_ids: strs(&["a", "b"]),
            disabled_processor_ids: vec![],
        };
        assert_eq!(
            describe_change(&previous, &strs(&["a", "c"]), &strs(&["c"])),
            Some("+c, -b".to_string())
        );
        assert_eq!(describe_change(&previous, &strs(&["b", "a"]), &[]), None);
    }
}
