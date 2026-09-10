//! Workspace-save snapshot helpers.
//!
//! The implementations moved to `services::snapshot`, which is the lock-
//! discipline choke point for owned reads of `AppState` (see its module docs).
//! This module stays as the import surface for `collect_session_data` in
//! `workspace_cmd.rs` and the other save-path callers, so the move was a
//! no-op at every call site.
//!
//! New code should import from `crate::services::snapshot` directly.

pub use crate::services::snapshot::{
    snapshot_bookmarks, snapshot_pipeline_meta, snapshot_workspace_analyses,
};
