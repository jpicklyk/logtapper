pub mod config;
pub mod detectors;
pub mod mapping;

use config::{AnonymizerConfig, category_for_id};
use detectors::{
    AndroidIdDetector, ApiKeyDetector, BearerTokenDetector, CustomDetector, EmailDetector,
    GaidDetector, ImeiDetector, Ipv4Detector, Ipv6Detector, JwtDetector, MacDetector,
    PhoneDetector, PiiDetector, PiiMatch, SerialDetector, SessionIdDetector,
    UrlCredentialsDetector, default_detectors,
};
use mapping::PiiMappings;

// ---------------------------------------------------------------------------
// LogAnonymizer
// ---------------------------------------------------------------------------

/// Sits between the parser and the processor pipeline.
/// Replaces PII spans with deterministic tokens and records `HighlightSpan`s
/// so the viewer can show the user where substitutions occurred.
pub struct LogAnonymizer {
    detectors: Vec<Box<dyn PiiDetector>>,
    pub mappings: PiiMappings,
}

impl LogAnonymizer {
    /// Build with the default detector set.
    pub fn new() -> Self {
        Self {
            detectors: default_detectors(),
            mappings: PiiMappings::new(),
        }
    }

    /// Build with a custom detector set.
    pub fn with_detectors(detectors: Vec<Box<dyn PiiDetector>>) -> Self {
        Self {
            detectors,
            mappings: PiiMappings::new(),
        }
    }

    /// Build with detectors selected by `AnonymizerConfig`.
    pub fn from_config(config: &AnonymizerConfig) -> Self {
        let mut detectors: Vec<Box<dyn PiiDetector>> = Vec::new();
        for entry in &config.detectors {
            if !entry.enabled {
                continue;
            }
            // Push built-in struct for known IDs
            match entry.id.as_str() {
                "email" => detectors.push(Box::new(EmailDetector)),
                "mac" => detectors.push(Box::new(MacDetector)),
                "ipv4" => detectors.push(Box::new(Ipv4Detector)),
                "ipv6" => detectors.push(Box::new(Ipv6Detector)),
                "imei" => detectors.push(Box::new(ImeiDetector)),
                "android_id" => detectors.push(Box::new(AndroidIdDetector)),
                "serial" => detectors.push(Box::new(SerialDetector)),
                "phone" => detectors.push(Box::new(PhoneDetector)),
                "jwt" => detectors.push(Box::new(JwtDetector)),
                "api_keys" => detectors.push(Box::new(ApiKeyDetector)),
                "bearer_token" => detectors.push(Box::new(BearerTokenDetector)),
                "gaid" => detectors.push(Box::new(GaidDetector)),
                "session_id" => detectors.push(Box::new(SessionIdDetector)),
                "url_credentials" => detectors.push(Box::new(UrlCredentialsDetector)),
                _ => {} // user-defined entry — no built-in struct
            }
            // Add user-added (non-builtin) enabled patterns for this entry
            for pattern in &entry.patterns {
                if !pattern.builtin && pattern.enabled {
                    if let Ok(det) =
                        CustomDetector::with_category(&pattern.regex, category_for_id(&entry.id))
                    {
                        detectors.push(Box::new(det));
                    }
                }
            }
        }
        Self {
            detectors,
            mappings: PiiMappings::new(),
        }
    }

    /// Anonymize `text` in-place and return the byte ranges that were replaced.
    ///
    /// Matches are deduplicated and sorted longest-first to prevent partial
    /// replacements when patterns overlap.
    pub fn anonymize(&self, text: &str) -> (String, Vec<ReplacedSpan>) {
        if self.detectors.is_empty() {
            return (text.to_string(), Vec::new());
        }

        // Collect all matches
        let mut all_matches: Vec<PiiMatch> = Vec::new();
        for det in &self.detectors {
            if !det.quick_screen(text) {
                continue;
            }
            all_matches.extend(det.find_all(text));
        }

        if all_matches.is_empty() {
            return (text.to_string(), Vec::new());
        }

        // Sort longest-first, tie-break by start position
        all_matches.sort_by(|a, b| {
            let len_a = a.range.end - a.range.start;
            let len_b = b.range.end - b.range.start;
            len_b.cmp(&len_a).then(a.range.start.cmp(&b.range.start))
        });

        // Greedy non-overlapping selection
        let mut used: Vec<PiiMatch> = Vec::new();
        'outer: for m in all_matches {
            for u in &used {
                if m.range.start < u.range.end && m.range.end > u.range.start {
                    continue 'outer; // overlaps
                }
            }
            used.push(m);
        }

        // Sort by start position for left-to-right replacement
        used.sort_by_key(|m| m.range.start);

        // Build the replacement string and collect span info
        let mut result = String::with_capacity(text.len());
        let mut replaced_spans: Vec<ReplacedSpan> = Vec::with_capacity(used.len());
        let mut cursor = 0usize;

        for m in &used {
            if m.range.start > cursor {
                result.push_str(&text[cursor..m.range.start]);
            }
            let token = self.mappings.token_for(&m.raw_value, m.category);
            let span_start = result.len();
            result.push_str(&token);
            replaced_spans.push(ReplacedSpan {
                start: span_start,
                end: result.len(),
            });
            cursor = m.range.end;
        }
        if cursor < text.len() {
            result.push_str(&text[cursor..]);
        }

        (result, replaced_spans)
    }
}

impl Default for LogAnonymizer {
    fn default() -> Self {
        Self::new()
    }
}

/// A byte range within the *output* string where a PII token was placed.
/// Used to generate `HighlightKind::PiiReplaced` spans for the viewer.
#[derive(Debug, Clone)]
pub struct ReplacedSpan {
    pub start: usize,
    pub end: usize,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_email() {
        let anon = LogAnonymizer::new();
        let (out, spans) = anon.anonymize("send to user@example.com please");
        assert!(!out.contains("user@example.com"), "email not replaced: {out}");
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn replaces_ipv4() {
        let anon = LogAnonymizer::new();
        let (out, spans) = anon.anonymize("connecting to 192.168.1.100:8080");
        assert!(!out.contains("192.168.1.100"), "IPv4 not replaced: {out}");
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn replaces_mac() {
        let anon = LogAnonymizer::new();
        let (out, spans) = anon.anonymize("MAC address: AA:BB:CC:DD:EE:FF connected");
        assert!(!out.contains("AA:BB"), "MAC not replaced: {out}");
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn deterministic_tokens() {
        let anon = LogAnonymizer::new();
        let (out1, _) = anon.anonymize("email=test@test.com");
        let (out2, _) = anon.anonymize("from test@test.com again");
        // Both occurrences should get the same token
        let tok1 = out1
            .split('=')
            .nth(1)
            .unwrap_or("")
            .trim();
        let tok2 = out2
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .trim();
        assert_eq!(tok1, tok2, "tokens should be deterministic across calls");
    }

    #[test]
    fn no_false_positives_on_plain_text() {
        let anon = LogAnonymizer::new();
        let text = "Normal log line with no PII content here";
        let (out, spans) = anon.anonymize(text);
        assert_eq!(out, text);
        assert!(spans.is_empty());
    }

    /// All 12 patterns observed as email false positives in real Android logs.
    #[test]
    fn no_email_false_positives_from_android_logs() {
        let anon = LogAnonymizer::new();
        let cases = [
            "SettingsProvider@SettingsProvider.apk",
            "CallLogBackup@CallLogBackup.apk",
            "apex@com.android.appsearch",
            "dump_report_55@86911.drpt",
            "apex@com.samsung.android.shell",
            "javalib@service-uwb.jar",
            "javalib@service-lifeguard.jar",
            "DualOutFocusViewer_S.apk@classes.dex",
            "android.hardware.usb@1.3-service.coral",
            "android.hardware.graphics.mapper@2.1.so",
            "androidx.work.systemjobscheduler@com.google.android",
            "android.hardware.sensors@2.0-service.multihal",
        ];
        for &case in &cases {
            let (out, spans) = anon.anonymize(case);
            assert!(
                spans.is_empty(),
                "Email false positive on: {case}\n  became: {out}"
            );
        }
    }

    /// Real email addresses must still be detected.
    #[test]
    fn email_true_positives_still_work() {
        let anon = LogAnonymizer::new();
        let cases = [
            "user@example.com",
            "user@sub.example.co.uk",
            "report@company.io",
            "alert@service.dev",
            "no-reply@mail.example.org",
        ];
        for &case in &cases {
            let (out, _spans) = anon.anonymize(case);
            assert!(
                !out.contains('@'),
                "Email true positive missed: {case}"
            );
        }
    }
}
