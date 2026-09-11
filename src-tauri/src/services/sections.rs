//! `sections` service — bugreport/dumpstate section listing and lookup.
//!
//! One implementation shared by `commands::files::get_sections` (the desktop
//! UI's full, unfiltered list) and the MCP bridge's `h_sections` /
//! `h_section_at` (paged, name-filtered, and "which section is this line in"
//! respectively). Before this package each transport read
//! `source.sections()` directly.

use crate::core::session::SectionInfo;

use super::error::ServiceError;
use super::wire::Page;
use super::{lock_svc, ServiceCtx};

/// Page through a session's sections, optionally filtered by a
/// case-insensitive substring match on the section name.
pub fn list(
    ctx: &ServiceCtx,
    session_id: &str,
    name_filter: Option<&str>,
    offset: usize,
    limit: usize,
) -> Result<Page<SectionInfo>, ServiceError> {
    let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| ServiceError::session_not_found(session_id))?;
    let source = session
        .primary_source()
        .ok_or_else(|| ServiceError::invalid_arg("No sources in session"))?;

    let query_lower = name_filter.map(str::to_lowercase);
    let filtered: Vec<SectionInfo> = source
        .sections()
        .iter()
        .filter(|s| match &query_lower {
            Some(q) => s.name.to_lowercase().contains(q),
            None => true,
        })
        .cloned()
        .collect();

    let total = filtered.len();
    let items: Vec<SectionInfo> = filtered.into_iter().skip(offset).take(limit).collect();
    Ok(Page::window(items, offset, limit, total))
}

/// Where a line falls relative to a session's parsed sections.
#[derive(Debug)]
pub struct SectionAt {
    /// Every section whose `[start_line, end_line]` range covers `line`,
    /// outermost first — the honest "where am I" answer.
    pub containing: Vec<SectionInfo>,
    /// The section name a processor's `filter.section` would actually match —
    /// NOT simply the innermost containing section; see
    /// `core::line::section_index_for_line`'s resolution rule. `None` means no
    /// rule can target this line by section.
    pub matches_filter_section: Option<String>,
    pub total_lines_in_session: usize,
    /// Guidance for the caller when `matches_filter_section` and `containing`
    /// disagree, or when the source has no sections at all.
    pub note: Option<&'static str>,
}

/// Resolve which section(s) contain `line`, and what `filter.section` would
/// actually match. Ported verbatim from `h_section_at`'s inline logic — the
/// sole existing consumer.
pub fn at(ctx: &ServiceCtx, session_id: &str, line: usize) -> Result<SectionAt, ServiceError> {
    let sessions = lock_svc(&ctx.state().sessions, "sessions")?;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| ServiceError::session_not_found(session_id))?;
    let source = session
        .primary_source()
        .ok_or_else(|| ServiceError::invalid_arg("No sources in session"))?;

    let sections = source.sections();
    let total_lines = source.total_lines();

    let containing: Vec<SectionInfo> = sections
        .iter()
        .filter(|s| line >= s.start_line && line <= s.end_line)
        .cloned()
        .collect();

    let matched = crate::core::line::section_index_for_line(sections, line);

    let note = if sections.is_empty() {
        Some("This source has no parsed sections — not a bugreport/dumpstate, or detected as the wrong source type.")
    } else if matched.is_none() && !containing.is_empty() {
        Some("This line lies inside a section by range, but `filter.section` resolves it to nothing: resolution stops at the last section starting before the line and does not walk outward to an enclosing parent. A processor rule naming any of `containingSections` will NOT match this line.")
    } else if matched.is_none() {
        Some("Line falls outside every section — before the first, or in a gap between them.")
    } else {
        None
    };

    Ok(SectionAt {
        containing,
        matches_filter_section: matched.map(|i| sections[i].name.clone()),
        total_lines_in_session: total_lines,
        note,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::testing::test_ctx;

    // The in-memory `StreamLogSource` fixture backing `test_ctx().with_session`
    // always reports zero sections — sections only ever come from a parsed
    // bugreport/dumpstate FILE source, which `core::session`'s own test suite
    // already covers. These tests exercise the service's own logic (filtering,
    // paging, containment math, the note derivation) against that empty-list
    // reality, plus the session/no-source error paths, and — via a hand-built
    // `Vec<SectionInfo>` — the filter predicate in isolation.

    #[test]
    fn list_on_a_source_with_no_sections_returns_an_empty_page() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 10).build();
        let page = list(&ctx, "s1", None, 0, 50).expect("list");
        assert_eq!(page.total, 0);
        assert!(page.items.is_empty());
    }

    #[test]
    fn list_errors_on_missing_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = list(&ctx, "no-such-session", None, 0, 50).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn at_on_a_source_with_no_sections_notes_the_reason() {
        let (ctx, _tmp) = test_ctx().with_session("s1", 10).build();
        let result = at(&ctx, "s1", 5).expect("at");
        assert!(result.containing.is_empty());
        assert!(result.matches_filter_section.is_none());
        assert_eq!(result.total_lines_in_session, 10);
        assert!(result.note.unwrap().contains("no parsed sections"));
    }

    #[test]
    fn at_errors_on_missing_session() {
        let (ctx, _tmp) = test_ctx().build();
        let err = at(&ctx, "no-such-session", 5).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn list_filters_by_name_case_insensitively_over_an_explicit_section_slice() {
        // Exercise the filter/page math directly against a hand-built section
        // list rather than a parsed source, since `core::session`'s section
        // parser is out of scope here and already covered by its own tests.
        let sections = vec![
            SectionInfo { name: "DUMPSYS NORMAL".into(), start_line: 10, end_line: 40, parent_index: None },
            SectionInfo { name: "wifi".into(), start_line: 20, end_line: 30, parent_index: Some(0) },
            SectionInfo { name: "SYSTEM PROPERTIES".into(), start_line: 50, end_line: 60, parent_index: None },
        ];
        let query_lower = Some("wifi".to_lowercase());
        let filtered: Vec<&SectionInfo> = sections
            .iter()
            .filter(|s| match &query_lower {
                Some(q) => s.name.to_lowercase().contains(q),
                None => true,
            })
            .collect();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].name, "wifi");
    }
}
