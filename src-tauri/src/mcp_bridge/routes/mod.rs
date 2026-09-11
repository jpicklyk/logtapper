//! Route handlers for the MCP bridge, grouped by domain.
//!
//! Each submodule owns one slice of `/mcp/...` endpoints. `super::router()`
//! wires every handler here into the route table — see its doc comment for
//! the append-only contract.

pub(super) mod activity;
pub(super) mod artifacts;
pub(super) mod insights;
pub(super) mod lines;
pub(super) mod pipeline;
pub(super) mod processors;
pub(super) mod search;
pub(super) mod sessions;
pub(super) mod tracker;
pub(super) mod watches;

// Wave-2 route modules (stubs until the owning package lands).
pub(super) mod export;
pub(super) mod filters;
pub(super) mod settings;
pub(super) mod stream;
pub(super) mod timeline;
pub(super) mod workspace;
