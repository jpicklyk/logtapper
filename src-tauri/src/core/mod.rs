pub mod analysis;
pub mod bookmark;
pub mod bugreport_parser;
pub mod filter;
pub mod kernel_parser;
pub mod line;
pub mod log_source;
pub mod logcat_parser;
pub mod parser;
pub mod pipeline;
pub mod session;
pub mod session_identity;
pub mod watch;

// ---------------------------------------------------------------------------
// Shared civil-date math
// ---------------------------------------------------------------------------
//
// Logcat-native timestamps (`MM-DD HH:MM:SS.mmm`) omit the year, so every
// caller that turns one into Unix-epoch nanoseconds needs (a) a way to infer
// the current year and (b) a way to turn a (year, month, day) triple into
// days-since-epoch. Both used to be copy-pasted verbatim into
// `logcat_parser::parse_timestamp_ns`, `bugreport_parser`, and
// `mcp_bridge::parse_iso_to_unix_nanos`. This is the single shared home —
// callers must produce byte-identical nanosecond values to before.

/// Days from the Unix epoch (1970-01-01) to a given civil date.
///
/// Era-based algorithm from <https://howardhinnant.github.io/date_algorithms.html>.
/// Shared by `logcat_parser::parse_timestamp_ns`, `bugreport_parser`
/// (`parse_dumpstate_timestamp` / `year_offset_ns`), and
/// `mcp_bridge::parse_iso_to_unix_nanos`.
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Infer the current UTC year from system time, for logcat-style timestamps
/// that omit the year. Approximate (365.25-day years) — good enough for year
/// inference, not for exact date math.
///
/// Shared by `logcat_parser::parse_timestamp_ns`, `bugreport_parser`
/// (`correct_logcat_year`), and `mcp_bridge::parse_iso_to_unix_nanos`.
pub(crate) fn infer_current_year() -> i64 {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    1970 + now_secs / 31_557_600 // 365.25 days
}

#[cfg(test)]
mod civil_date_tests {
    use super::*;

    /// Known-correct reference values for `days_from_civil`, cross-checked
    /// against the Hinnant algorithm's own worked examples.
    #[test]
    fn days_from_civil_known_values() {
        // Unix epoch itself.
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        // One day before the epoch.
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        // A well-known reference date (2000-03-01, per Hinnant's examples).
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        // Y2K.
        assert_eq!(days_from_civil(2000, 1, 1), 10_957);
        // A leap-day date.
        assert_eq!(days_from_civil(2024, 2, 29), 19_782);
    }

    #[test]
    fn infer_current_year_is_plausible() {
        // Sanity bound only — this is a smoke test, not a determinism check
        // (the real value depends on wall-clock time at test run).
        let year = infer_current_year();
        assert!(year >= 2024 && year < 2100, "unexpected inferred year: {year}");
    }
}
