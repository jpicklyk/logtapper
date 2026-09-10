//! Filesystem-location and task-spawning abstractions.
//!
//! Services that persist config or spawn background work would otherwise reach
//! for `AppHandle::path()` / `tauri::async_runtime::spawn` and become
//! Tauri-bound. These two traits are the seam; `TauriPaths` / `TauriSpawner`
//! in `commands/adapters.rs` are the production implementations.

use std::path::PathBuf;

use futures_util::future::BoxFuture;

use super::error::ServiceError;

/// Where the app keeps its own files (config, processors, packs, spill files).
pub trait AppPaths: Send + Sync {
    /// The per-user application data directory. Callers are responsible for
    /// `create_dir_all` before writing — this only resolves the location.
    fn app_data_dir(&self) -> Result<PathBuf, ServiceError>;
}

/// Fire-and-forget async task spawning.
///
/// Kept as a trait because `commands/files.rs`'s background indexer relies on
/// `tauri::async_runtime::spawn` specifically (it must land on the runtime
/// Tauri drives), while tests want either an immediate no-op or a plain tokio
/// spawn.
pub trait Spawner: Send + Sync {
    fn spawn(&self, fut: BoxFuture<'static, ()>);
}

/// An [`AppPaths`] that always resolves to a fixed directory. Used by tests
/// (pointed at a `TempDir`) and by any context with no `AppHandle`.
#[derive(Debug, Clone)]
pub struct FixedPaths(pub PathBuf);

impl AppPaths for FixedPaths {
    fn app_data_dir(&self) -> Result<PathBuf, ServiceError> {
        Ok(self.0.clone())
    }
}

/// A [`Spawner`] that drops the future without polling it.
///
/// Only correct where the spawned work is genuinely optional (test contexts,
/// or a service invoked outside any runtime). It logs at `warn` rather than
/// failing silently so a production misconfiguration is visible.
#[derive(Debug, Clone, Copy, Default)]
pub struct NullSpawner;

impl Spawner for NullSpawner {
    fn spawn(&self, _fut: BoxFuture<'static, ()>) {
        log::warn!("[services] NullSpawner dropped a background task without running it");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_paths_returns_its_dir() {
        let p = FixedPaths(PathBuf::from("/tmp/lt-test"));
        assert_eq!(p.app_data_dir().unwrap(), PathBuf::from("/tmp/lt-test"));
    }

    #[test]
    fn null_spawner_drops_without_polling() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let ran = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&ran);
        let s: &dyn Spawner = &NullSpawner;
        s.spawn(Box::pin(async move {
            flag.store(true, Ordering::SeqCst);
        }));
        assert!(!ran.load(Ordering::SeqCst));
    }
}
