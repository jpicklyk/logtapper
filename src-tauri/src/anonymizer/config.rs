use serde::{Deserialize, Serialize};
use super::detectors::PiiCategory;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnonymizerConfig {
    pub detectors: Vec<DetectorEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorEntry {
    /// Stable key used to map to the built-in detector struct.
    pub id: String,
    /// Display name shown in the UI.
    pub label: String,
    /// "tier1" | "tier2" | "tier3" — controls UI grouping and FP warnings.
    pub tier: String,
    /// Short false-positive rate hint shown in the UI.
    pub fp_hint: String,
    pub enabled: bool,
    pub patterns: Vec<PatternEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternEntry {
    /// Human-readable label for the pattern, e.g. "AWS Access Key".
    pub label: String,
    pub regex: String,
    /// True = shipped with the app; shown as read-only in the UI.
    pub builtin: bool,
    pub enabled: bool,
}

/// Map a well-known detector id to its PiiCategory.
/// Unknown ids (user custom entries) → PiiCategory::Custom.
pub fn category_for_id(id: &str) -> PiiCategory {
    match id {
        "email" => PiiCategory::Email,
        "ipv4" => PiiCategory::Ipv4,
        "ipv6" => PiiCategory::Ipv6,
        "mac" => PiiCategory::Mac,
        "phone" => PiiCategory::Phone,
        "imei" => PiiCategory::Imei,
        "serial" => PiiCategory::Serial,
        "android_id" => PiiCategory::AndroidId,
        "jwt" => PiiCategory::Jwt,
        "api_keys" => PiiCategory::ApiKey,
        "bearer_token" => PiiCategory::BearerToken,
        "gaid" => PiiCategory::Gaid,
        "session_id" => PiiCategory::SessionId,
        "url_credentials" => PiiCategory::UrlCredentials,
        _ => PiiCategory::Custom,
    }
}

impl AnonymizerConfig {
    pub fn with_defaults() -> Self {
        Self {
            detectors: default_detector_entries(),
        }
    }
}

fn p(label: &str, regex: &str) -> PatternEntry {
    PatternEntry {
        label: label.to_string(),
        regex: regex.to_string(),
        builtin: true,
        enabled: true,
    }
}

fn default_detector_entries() -> Vec<DetectorEntry> {
    vec![
        DetectorEntry {
            id: "email".to_string(),
            label: "Email Address".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<1%".to_string(),
            enabled: true,
            patterns: vec![p("Email (RFC 5321 dot-atom)", r"\b[a-zA-Z0-9][a-zA-Z0-9._%+\-]{0,62}@[a-zA-Z][a-zA-Z0-9\-]*(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,10}\b")],
        },
        DetectorEntry {
            id: "mac".to_string(),
            label: "MAC Address".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<1%".to_string(),
            enabled: true,
            patterns: vec![p("MAC address (colon or dash)", r"(?i)\b(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}\b")],
        },
        DetectorEntry {
            id: "ipv4".to_string(),
            label: "IPv4 Address".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<2%".to_string(),
            enabled: true,
            patterns: vec![p(
                "IPv4 (dotted decimal, no leading zeros)",
                r"\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\b",
            )],
        },
        DetectorEntry {
            id: "ipv6".to_string(),
            label: "IPv6 Address".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<1%".to_string(),
            enabled: true,
            patterns: vec![p(
                "IPv6 (full or compressed)",
                r"(?i)\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}:)*[0-9a-f]{1,4}\b|\b::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*\b",
            )],
        },
        DetectorEntry {
            id: "imei".to_string(),
            label: "IMEI (15-digit)".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<2%".to_string(),
            enabled: true,
            patterns: vec![p("IMEI (15 digits)", r"\b\d{15}\b")],
        },
        DetectorEntry {
            id: "android_id".to_string(),
            label: "Android ID".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<5%".to_string(),
            enabled: true,
            patterns: vec![p("Android ID (16 hex chars)", r"\b[0-9a-fA-F]{16}\b")],
        },
        DetectorEntry {
            id: "serial".to_string(),
            label: "Serial Number".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<2%".to_string(),
            enabled: true,
            patterns: vec![p(
                "Serial (keyword-anchored)",
                r"(?i)(?:serial\s*[=:]\s*|SN[:\s])([A-Za-z0-9]{6,20})",
            )],
        },
        DetectorEntry {
            id: "jwt".to_string(),
            label: "JWT Token".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<1%".to_string(),
            enabled: true,
            patterns: vec![p(
                "JWT (eyJ prefix)",
                r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}=*",
            )],
        },
        DetectorEntry {
            id: "api_keys".to_string(),
            label: "API Keys".to_string(),
            tier: "tier1".to_string(),
            fp_hint: "<1%".to_string(),
            enabled: true,
            patterns: vec![
                p("AWS Access Key (AKIA)", r"\bAKIA[0-9A-Z]{16}\b"),
                p("GitHub PAT (ghp_)", r"\bghp_[0-9a-zA-Z]{36}\b"),
                p("Stripe secret key", r"\bsk_(?:live|test)_[0-9a-zA-Z]{24,99}\b"),
                p("Google API key (AIza)", r"\bAIza[0-9A-Za-z\-_]{35}\b"),
                p("Slack token (xox)", r"\bxox[pboas]-[0-9a-zA-Z\-]{10,99}\b"),
            ],
        },
        DetectorEntry {
            id: "bearer_token".to_string(),
            label: "Bearer Token".to_string(),
            tier: "tier2".to_string(),
            fp_hint: "<5%".to_string(),
            enabled: true,
            patterns: vec![p(
                "Bearer header value",
                r"(?i)Bearer\s+[A-Za-z0-9\-_~+/]{32,}",
            )],
        },
        DetectorEntry {
            id: "gaid".to_string(),
            label: "Google Advertising ID".to_string(),
            tier: "tier2".to_string(),
            fp_hint: "10-15%".to_string(),
            enabled: true,
            patterns: vec![p(
                "GAID (keyword-anchored UUID)",
                r"(?i)(?:gaid|advertising_id|google_ad_id)\s*[=:]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
            )],
        },
        DetectorEntry {
            id: "session_id".to_string(),
            label: "Session ID / Cookie".to_string(),
            tier: "tier2".to_string(),
            fp_hint: "5-10%".to_string(),
            enabled: true,
            patterns: vec![p(
                "Session ID (keyword-anchored)",
                r"(?i)(?:session_id|sessionid|jsessionid|phpsessid)\s*[=:]\s*([a-zA-Z0-9]{20,})",
            )],
        },
        DetectorEntry {
            id: "url_credentials".to_string(),
            label: "URL Credentials".to_string(),
            tier: "tier2".to_string(),
            fp_hint: "<5%".to_string(),
            enabled: true,
            patterns: vec![p(
                "URL with embedded credentials",
                r"(?i)(?:https?|postgres|mysql|mongodb|redis|ftp|smtp|amqp|s3)://[^\s:@/]+:[^\s:@/]+@[^\s/]+",
            )],
        },
        DetectorEntry {
            id: "phone".to_string(),
            label: "Phone Number".to_string(),
            tier: "tier3".to_string(),
            fp_hint: "25-40%".to_string(),
            enabled: false, // off by default — noisy
            patterns: vec![
                p("E.164 international", r"\+[1-9]\d{1,14}\b"),
                p(
                    "US flexible",
                    r"\b(?:\+?1[-.]?)?\(?[2-9]\d{2}\)?[-.]?\d{3}[-.]?\d{4}\b",
                ),
            ],
        },
    ]
}
