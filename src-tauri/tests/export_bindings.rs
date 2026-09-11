//! TypeScript binding export (`npm run gen:types`).
//!
//! Run with:
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --test export_bindings
//! ```
//!
//! `ts-rs` writes one `.ts` file per exported type into the directory named by
//! `TS_RS_EXPORT_DIR` (set in the repository-root `.cargo/config.toml` to
//! `src-next/bridge/generated`). This test is the ONLY export trigger — no type
//! carries `#[ts(export)]`, so nothing is written by an unrelated `cargo test`.
//!
//! Each entry in [`ROOT_TYPES`] is a *root*: a type that crosses the IPC boundary
//! on its own (a `#[tauri::command]` return type or argument struct, a Tauri event
//! payload, or a `services::wire` envelope). `TS::export_all()` walks each root's
//! transitive dependencies, so intermediate structs need only the `TS` derive —
//! they do not need to be listed here.
//!
//! To add a package's types: add one line per new root to `ROOT_TYPES!`.
//!
//! The test is idempotent and deterministic: `export_all()` overwrites each file
//! with byte-identical content for unchanged types, and the `index.ts` barrel is
//! rebuilt from a sorted directory listing with LF line endings.

use std::collections::BTreeSet;
use std::path::PathBuf;

use ts_rs::TS;

/// Every IPC-reachable root type, in one place. Adding a package means adding
/// one line here.
///
/// Invoked with a macro name; that macro receives the whole comma-separated
/// type list (see [`export_each`] and [`count_types`]).
macro_rules! ROOT_TYPES {
    ($apply:ident) => {
        $apply![
            // --- services/wire.rs — shared response envelopes -----------------
            // Generic envelopes export as `Page<T>` / `Sampled<T>` / `Truncated<T>`;
            // the concrete parameter below only picks an instantiation to export from.
            app_lib::services::wire::Page<app_lib::core::line::ViewLine>,
            app_lib::services::wire::Sampled<app_lib::core::line::ViewLine>,
            app_lib::services::wire::Truncated<app_lib::core::line::ViewLine>,
            app_lib::services::wire::LineStrategy,
            app_lib::services::wire::LinePage,
            app_lib::services::wire::LineStats,
            app_lib::services::wire::SearchHit,
            app_lib::services::wire::SearchHits,
            app_lib::services::wire::PipelineRunResult,
            // --- services — caller model, activity journal, progress events ---
            app_lib::services::Caller,
            app_lib::services::activity::ActivityEntry,
            app_lib::services::events::ProgressEvent,
            app_lib::services::events::PipelineProgressEvent,
            app_lib::services::events::SearchProgressEvent,
            app_lib::services::events::FilterProgressEvent,
            app_lib::services::events::IndexProgressEvent,
            // --- core/line.rs — the viewer wire shapes ------------------------
            app_lib::core::line::LineRequest,
            app_lib::core::line::LineWindow,
            app_lib::core::line::SearchQuery,
            app_lib::core::line::SearchSummary,
            app_lib::core::line::ViewLine,
            app_lib::core::line::ViewMode,
            app_lib::core::line::LogLevel,
            app_lib::core::line::HighlightSpan,
            app_lib::core::line::HighlightKind,
            // --- sessions, sections, filters, watches -------------------------
            app_lib::core::session::SectionInfo,
            app_lib::core::filter::FilterCriteria,
            app_lib::core::watch::WatchInfo,
            app_lib::core::watch::WatchMatchEvent,
            app_lib::services::watches::WatchUpdateEvent,
            app_lib::services::filters::FilterCreateResult,
            app_lib::services::filters::FilteredLinesResult,
            app_lib::services::filters::FilterInfo,
            app_lib::commands::filter::FilterProgress,
            app_lib::commands::files::LoadResult,
            app_lib::commands::files::DumpstateMetadata,
            app_lib::commands::files::FileIndexProgress,
            app_lib::commands::files::FileIndexComplete,
            app_lib::commands::files::SearchProgress,
            app_lib::commands::session::McpStatus,
            app_lib::commands::session::SessionMetadata,
            app_lib::commands::bridge_access::McpOpenAllowlist,
            app_lib::commands::mcp::McpBundleInfo,
            app_lib::commands::file_associations::FileAssocEntry,
            // --- ADB streaming ------------------------------------------------
            app_lib::commands::adb::AdbDevice,
            app_lib::commands::adb::AdbStreamEvent,
            app_lib::commands::adb::AdbBatch,
            app_lib::commands::adb::AdbProcessorUpdate,
            app_lib::commands::adb::AdbStreamStopped,
            app_lib::commands::adb::AdbTrackerUpdate,
            // --- processors, packs, pipeline ----------------------------------
            app_lib::processors::ProcessorSummary,
            app_lib::processors::pack::PackSummary,
            app_lib::commands::pipeline::PipelineRunSummary,
            app_lib::commands::pipeline::PipelineProgress,
            app_lib::commands::processors::MatchedLineInfo,
            app_lib::processors::state_tracker::types::StateSnapshot,
            app_lib::processors::state_tracker::types::StateTransition,
            // Reached only through a `#[ts(type = "Record<…>")]` override, which
            // clears ts-rs's dependency tracking — so these two must be roots or
            // the inline `import('./…')` in their parents dangles.
            app_lib::processors::state_tracker::types::FieldChange,
            app_lib::processors::correlator::engine::SourceMatchRecord,
            app_lib::processors::correlator::engine::CorrelatorResult,
            // --- insights (WP-3) -- ProcessorInsight/InsightSignal are pulled
            // in transitively; only the root needs listing here.
            app_lib::services::insights::Insights,
            // --- marketplace / update engine ----------------------------------
            app_lib::processors::marketplace::Source,
            // Bug ee4ddb0b (WP-9): `Source.source_type` is now `#[serde(flatten)]`
            // + `#[ts(flatten)]`, which — like the `#[ts(type = "Record<…>")]`
            // overrides above — clears ts-rs's dependency tracking: `Source.ts`
            // now inlines this type's variants rather than importing it, so
            // without an explicit root here this file would go stale (freeze on
            // its pre-fix `git_ref` shape) the moment nothing else reaches it.
            app_lib::processors::marketplace::SourceType,
            app_lib::processors::marketplace::MarketplacePackEntry,
            app_lib::commands::sources::MarketplaceFetchResult,
            app_lib::commands::sources::UpdateCheckResult,
            app_lib::commands::sources::UpdateResult,
            app_lib::commands::sources::UpdateAvailable,
            app_lib::commands::sources::PackUpdateAvailable,
            // --- artifacts: bookmarks + analyses ------------------------------
            app_lib::core::bookmark::Bookmark,
            app_lib::core::bookmark::CreatedBy,
            app_lib::core::bookmark::BookmarkUpdateEvent,
            app_lib::core::analysis::AnalysisArtifact,
            app_lib::core::analysis::AnalysisSection,
            app_lib::core::analysis::AnalysisUpdateEvent,
            // --- anonymizer / settings (WP-12) ---------------------------------
            app_lib::anonymizer::config::AnonymizerConfig,
            app_lib::services::settings::AnonymizerTestResult,
            // --- charts / timeline / export (WP-10) ---------------------------
            // TimelineSeriesData / ExportAllSessionsInfo / ExportAllOptions moved
            // from `commands::{charts,export}` to `services::{timeline,export}`;
            // ts-rs names files after the Rust type name, not its module path, so
            // this is a path-only change — generated output is unaffected.
            app_lib::charts::builder::ChartData,
            app_lib::services::timeline::TimelineSeriesData,
            app_lib::services::export::ExportAllSessionsInfo,
            app_lib::services::export::ExportAllOptions,
            // --- workspace (.ltw / .lts) --------------------------------------
            app_lib::services::workspace::SaveWorkspaceOptions,
            app_lib::services::workspace::AutoSaveWorkspaceOptions,
            app_lib::services::workspace::SyncWorkspaceEnvelopeOptions,
            app_lib::services::workspace::LoadWorkspaceResult,
            app_lib::services::workspace::RestoreSessionOptions,
            // WP-8: the agent-facing result/summary shapes and the two
            // workspace event payloads, which used to be ad hoc `json!{}`.
            app_lib::services::workspace::RestoreSessionResult,
            app_lib::services::workspace::RestoredSession,
            app_lib::services::workspace::WorkspaceLoadOutcome,
            app_lib::services::workspace::WorkspaceSummary,
            app_lib::services::workspace::WorkspaceRestoredEvent,
            app_lib::services::workspace::WorkspaceAutoSavedEvent,
            app_lib::workspace::app_state::WorkspaceEntry,
            app_lib::workspace::app_state::AppStateFile,
            app_lib::workspace::lts::LtsEditorTab,
            // --- sessions (WP-6) -----------------------------------------------
            app_lib::services::sessions::SessionClosedEvent,
        ]
    };
}

/// `export_all()` on every listed type, collecting failures instead of panicking
/// on the first one.
macro_rules! export_each {
    ($($ty:ty),+ $(,)?) => {{
        let mut failures: Vec<String> = Vec::new();
        $(
            if let Err(e) = <$ty as TS>::export_all() {
                failures.push(format!("{}: {e}", stringify!($ty)));
            }
        )+
        failures
    }};
}

macro_rules! count_types {
    ($($ty:ty),+ $(,)?) => { 0usize $(+ { let _ = stringify!($ty); 1usize })+ };
}

/// Directory ts-rs writes into — mirrors the `TS_RS_EXPORT_DIR` resolution so the
/// barrel is written next to the generated files.
fn export_dir() -> PathBuf {
    match std::env::var("TS_RS_EXPORT_DIR") {
        Ok(dir) => PathBuf::from(dir),
        // Fallback for a run without the repo's `.cargo/config.toml` (e.g. a
        // vendored build): resolve relative to the manifest.
        Err(_) => PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src-next/bridge/generated"),
    }
}

const BARREL_HEADER: &str = "// GENERATED by cargo test --test export_bindings — do not edit\n";

/// Rebuild `index.ts` from a sorted listing of the export directory.
///
/// Deterministic: `BTreeSet` sorts the stems, every line ends in a bare `\n`, and
/// the file is only rewritten when the content actually differs (so a no-op run
/// leaves the mtime alone).
fn write_barrel(dir: &PathBuf) -> std::io::Result<usize> {
    let mut stems: BTreeSet<String> = BTreeSet::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ts") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem == "index" {
            continue;
        }
        stems.insert(stem.to_string());
    }

    let mut out = String::from(BARREL_HEADER);
    for stem in &stems {
        out.push_str(&format!("export type {{ {stem} }} from './{stem}';\n"));
    }

    let index = dir.join("index.ts");
    let current = std::fs::read_to_string(&index).unwrap_or_default();
    if current != out {
        std::fs::write(&index, out.as_bytes())?;
    }
    Ok(stems.len())
}

#[test]
fn export_all() {
    let dir = export_dir();
    std::fs::create_dir_all(&dir).expect("create export dir");

    let failures = ROOT_TYPES!(export_each);
    assert!(failures.is_empty(), "ts-rs export failed:\n  {}", failures.join("\n  "));

    let written = write_barrel(&dir).expect("write index.ts barrel");
    let roots = ROOT_TYPES!(count_types);

    // Transitive dependencies mean the file count always exceeds the root count;
    // a count at or below it means `export_all()` silently wrote nothing.
    assert!(
        written >= roots,
        "expected at least {roots} generated files (one per root), found {written} in {}",
        dir.display()
    );

    println!("exported {written} type(s) from {roots} root(s) into {}", dir.display());
}

/// The overrides that keep untyped Rust payloads and 64-bit integers from
/// leaking into the frontend as `any`, `JsonValue` or `bigint`. These assert on
/// the generated declaration text rather than on the file, so a dropped
/// `#[ts(...)]` attribute fails here and not silently in `tsc`.
#[test]
fn wire_shape_overrides_hold() {
    use app_lib::services::workspace::LoadWorkspaceResult;
    use app_lib::core::line::{SearchSummary, ViewLine};
    use app_lib::processors::ProcessorSummary;
    use app_lib::processors::state_tracker::types::{FieldChange, StateSnapshot, StateTransition};

    // `HashMap<String, _>` must land as `Record<string, _>`, not ts-rs's default
    // `{ [key in string]?: _ }` index signature (whose values are `_ | undefined`).
    for (name, decl) in [
        ("StateSnapshot", StateSnapshot::decl()),
        ("StateTransition", StateTransition::decl()),
        ("SearchSummary", SearchSummary::decl()),
    ] {
        assert!(
            decl.contains("Record<string, ") && !decl.contains("[key in string]"),
            "{name} lost its Record<> override:
{decl}"
        );
    }

    // `serde_json::Value` is opaque on the wire: `unknown`, never ts-rs's
    // `JsonValue` (which imports from a `serde_json/` subdirectory the barrel
    // does not re-export) and never `any`.
    for (name, decl) in [
        ("FieldChange", FieldChange::decl()),
        ("StateSnapshot", StateSnapshot::decl()),
        ("LoadWorkspaceResult", LoadWorkspaceResult::decl()),
    ] {
        assert!(
            !decl.contains("JsonValue") && !decl.contains(": any"),
            "{name} leaked an untyped JSON value:
{decl}"
        );
    }

    // Tauri IPC is JSON — a `u64`/`i64` arrives in JS as `number`. ts-rs's default
    // `bigint` would be a lie every consumer has to cast away.
    let view_line = ViewLine::decl();
    assert!(
        !view_line.contains("bigint"),
        "ViewLine.timestamp regressed to bigint:
{view_line}"
    );

    // `#[ts(optional)]` tracks `skip_serializing_if = "Option::is_none"`.
    let summary = ProcessorSummary::decl();
    assert!(
        summary.contains("trackerMode?:"),
        "ProcessorSummary lost its #[ts(optional)] markers:
{summary}"
    );
}

/// No generated file may reference a 64-bit integer as `bigint`: everything
/// crossing Tauri IPC is JSON, so an unoverridden `u64`/`i64` is a silent
/// contract break for every TypeScript consumer.
#[test]
fn no_bigint_escapes_into_the_bindings() {
    let dir = export_dir();
    let mut offenders: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        // `export_all` creates the directory; nothing to check on a fresh clone
        // where this test happens to run first.
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ts") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if text.contains("bigint") {
                offenders.push(path.file_name().unwrap().to_string_lossy().into_owned());
            }
        }
    }
    offenders.sort();
    assert!(
        offenders.is_empty(),
        "bigint leaked into: {}. Add #[ts(type = \"number\")] to the offending u64/i64 field.",
        offenders.join(", ")
    );
}
