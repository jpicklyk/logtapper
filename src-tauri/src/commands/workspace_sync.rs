//! Workspace-save snapshot helpers.
//!
//! The implementations moved to `services::snapshot`, which is the lock-
//! discipline choke point for owned reads of `AppState` (see its module docs).
//! This module stays only as the import surface for the two call sites that
//! still name it (`commands::export`, `workspace::autosave`), so the move was
//! a no-op at every call site.
//!
//! New code should import from `crate::services::snapshot` directly.

pub use crate::services::snapshot::{
    snapshot_bookmarks, snapshot_pipeline_meta, snapshot_workspace_analyses,
};
