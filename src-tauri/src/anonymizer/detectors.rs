use regex::Regex;
use std::ops::Range;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// PII category
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PiiCategory {
    Email,
    Ipv4,
    Ipv6,
    Mac,
    Phone,
    Imei,
    Serial,
    AndroidId,
    Jwt,
    ApiKey,
    BearerToken,
    Gaid,
    SessionId,
    UrlCredentials,
    Custom,
}

impl PiiCategory {
    pub fn prefix(self) -> &'static str {
        match self {
            PiiCategory::Email => "EMAIL",
            PiiCategory::Ipv4 => "IPv4",
            PiiCategory::Ipv6 => "IPv6",
            PiiCategory::Mac => "MAC",
            PiiCategory::Phone => "PHONE",
            PiiCategory::Imei => "IMEI",
            PiiCategory::Serial => "SERIAL",
            PiiCategory::AndroidId => "AID",
            PiiCategory::Jwt => "JWT",
            PiiCategory::ApiKey => "KEY",
            PiiCategory::BearerToken => "TOKEN",
            PiiCategory::Gaid => "GAID",
            PiiCategory::SessionId => "SESSION",
            PiiCategory::UrlCredentials => "CRED",
            PiiCategory::Custom => "PII",
        }
    }
}

// ---------------------------------------------------------------------------
// PiiMatch
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PiiMatch {
    pub range: Range<usize>,
    pub category: PiiCategory,
    pub raw_value: String,
}

// ---------------------------------------------------------------------------
// PiiDetector trait
// ---------------------------------------------------------------------------

pub trait PiiDetector: Send + Sync {
    fn category(&self) -> PiiCategory;
    /// Pre-screen a line quickly (cheap check before running full regex).
    fn quick_screen(&self, text: &str) -> bool {
        let _ = text;
        true
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn regex_matches(re: &Regex, text: &str, category: PiiCategory) -> Vec<PiiMatch> {
    re.find_iter(text)
        .map(|m| PiiMatch {
            range: m.start()..m.end(),
            category,
            raw_value: m.as_str().to_string(),
        })
        .collect()
}

fn capture_group1_matches(re: &Regex, text: &str, category: PiiCategory) -> Vec<PiiMatch> {
    re.captures_iter(text)
        .filter_map(|cap| cap.get(1).map(|m| PiiMatch {
            range: m.start()..m.end(),
            category,
            raw_value: m.as_str().to_string(),
        }))
        .collect()
}

// ---------------------------------------------------------------------------
// Email detector
// ---------------------------------------------------------------------------

static EMAIL_RE: OnceLock<Regex> = OnceLock::new();

/// File extensions that appear as TLDs in Android logs but are never real email TLDs.
/// Used to post-filter `EmailDetector` matches.
const EMAIL_EXT_BLOCKLIST: &[&str] = &[
    "apk", "apks", "xapk", "apex",   // Android package formats
    "so", "odex", "vdex", "elf",      // native / compiled
    "jar", "aar", "dex",              // JVM bytecode
    "exe", "dll", "bin", "lib",       // generic binaries
    "drpt", "zip", "gz", "tar",       // data / archive
];

/// Returns true if the regex-matched "email" is actually an Android build artifact.
///
/// Two checks (both needed because Android logs produce two distinct FP patterns):
/// 1. TLD is a known file extension (e.g. `Foo@Bar.apk`, `lib@service.jar`).
/// 2. First domain label is a reverse-domain prefix (`com`, `org`, `net`, `edu`, `gov`).
///    Real MX records never start with these; Android package names always do
///    (e.g. `apex@com.android.appsearch`).
fn is_android_artifact(m: &str) -> bool {
    // Check 1: file-extension TLD
    if let Some(dot) = m.rfind('.') {
        let tld = m[dot + 1..].to_ascii_lowercase();
        if EMAIL_EXT_BLOCKLIST.contains(&tld.as_str()) {
            return true;
        }
    }
    // Check 2: reverse-domain package prefix
    if let Some(at) = m.find('@') {
        let first_label = m[at + 1..].split('.').next().unwrap_or("");
        const REV_PREFIXES: &[&str] = &["com", "org", "net", "edu", "gov"];
        let fl = first_label.to_ascii_lowercase();
        if REV_PREFIXES.contains(&fl.as_str()) {
            return true;
        }
    }
    false
}

pub struct EmailDetector;

impl PiiDetector for EmailDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Email
    }
    fn quick_screen(&self, text: &str) -> bool {
        text.contains('@')
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        // RFC 5321 dot-atom format (ASCII only).
        // First domain label requires a letter start (`[a-zA-Z]`) to reject version-number
        // domains like `foo@1.3-service.coral` or `lib@86911.drpt`.
        // Post-filtered by `is_android_artifact()` to remove file-extension TLDs and
        // reverse-domain Android package names that survive the regex.
        let re = EMAIL_RE.get_or_init(|| {
            Regex::new(r"\b[a-zA-Z0-9][a-zA-Z0-9._%+\-]{0,62}@[a-zA-Z][a-zA-Z0-9\-]*(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,10}\b").unwrap()
        });
        re.find_iter(text)
            .filter(|m| !is_android_artifact(m.as_str()))
            .map(|m| PiiMatch {
                range: m.start()..m.end(),
                category: PiiCategory::Email,
                raw_value: m.as_str().to_string(),
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// IPv4 detector
// ---------------------------------------------------------------------------

static IPV4_RE: OnceLock<Regex> = OnceLock::new();

pub struct Ipv4Detector;

impl PiiDetector for Ipv4Detector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Ipv4
    }
    fn quick_screen(&self, text: &str) -> bool {
        // Counting dots catches package names like `com.google.android.gms` (3+ dots, no digits
        // before the dot). Checking for digit→dot filters those out, since IPv4 octets always
        // start with a digit (e.g. "192.") while Java package segments start with a letter.
        text.as_bytes().windows(2).any(|w| w[0].is_ascii_digit() && w[1] == b'.')
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = IPV4_RE.get_or_init(|| {
            Regex::new(r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b")
                .unwrap()
        });
        regex_matches(re, text, PiiCategory::Ipv4)
    }
}

// ---------------------------------------------------------------------------
// IPv6 detector
// ---------------------------------------------------------------------------

static IPV6_RE: OnceLock<Regex> = OnceLock::new();

pub struct Ipv6Detector;

impl PiiDetector for Ipv6Detector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Ipv6
    }
    fn quick_screen(&self, text: &str) -> bool {
        // IPv6 always has at least two colons (e.g. "::1", "2001:db8::1")
        text.as_bytes().iter().filter(|&&b| b == b':').count() >= 2
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = IPV6_RE.get_or_init(|| {
            Regex::new(
                r"(?i)\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}:)*[0-9a-f]{1,4}\b|\b::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*\b",
            )
            .unwrap()
        });
        regex_matches(re, text, PiiCategory::Ipv6)
    }
}

// ---------------------------------------------------------------------------
// MAC address detector
// ---------------------------------------------------------------------------

static MAC_RE: OnceLock<Regex> = OnceLock::new();

pub struct MacDetector;

impl PiiDetector for MacDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Mac
    }
    fn quick_screen(&self, text: &str) -> bool {
        text.contains(':')
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = MAC_RE.get_or_init(|| {
            Regex::new(r"(?i)\b(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}\b").unwrap()
        });
        regex_matches(re, text, PiiCategory::Mac)
    }
}

// ---------------------------------------------------------------------------
// Phone number detector (tier3, off by default)
// ---------------------------------------------------------------------------

static PHONE_RE: OnceLock<Regex> = OnceLock::new();

pub struct PhoneDetector;

impl PiiDetector for PhoneDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Phone
    }
    fn quick_screen(&self, text: &str) -> bool {
        // E.164 always has '+'; US format requires at least 10 consecutive digits.
        if text.contains('+') {
            return true;
        }
        let mut run = 0u8;
        for &b in text.as_bytes() {
            if b.is_ascii_digit() {
                run += 1;
                if run >= 7 {
                    return true;
                }
            } else {
                run = 0;
            }
        }
        false
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = PHONE_RE.get_or_init(|| {
            Regex::new(r"(?:\+?\d[\d\s\-.()/]{7,}\d)").unwrap()
        });
        regex_matches(re, text, PiiCategory::Phone)
    }
}

// ---------------------------------------------------------------------------
// IMEI detector (15-digit)
// ---------------------------------------------------------------------------

static IMEI_RE: OnceLock<Regex> = OnceLock::new();

pub struct ImeiDetector;

impl PiiDetector for ImeiDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Imei
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = IMEI_RE.get_or_init(|| Regex::new(r"\b\d{15}\b").unwrap());
        regex_matches(re, text, PiiCategory::Imei)
    }
}

// ---------------------------------------------------------------------------
// Serial number detector
// ---------------------------------------------------------------------------

static SERIAL_RE: OnceLock<Regex> = OnceLock::new();

pub struct SerialDetector;

impl PiiDetector for SerialDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Serial
    }
    fn quick_screen(&self, text: &str) -> bool {
        // Include SERIAL (all-caps) because the regex is (?i) but contains() is case-sensitive.
        text.contains("serial") || text.contains("Serial") || text.contains("SERIAL") || text.contains("SN")
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = SERIAL_RE.get_or_init(|| {
            Regex::new(r"(?i)(?:serial\s*[=:]\s*|SN[:\s])([A-Za-z0-9]{6,20})").unwrap()
        });
        capture_group1_matches(re, text, PiiCategory::Serial)
    }
}

// ---------------------------------------------------------------------------
// Android ID detector (16 hex chars)
// ---------------------------------------------------------------------------

static AID_RE: OnceLock<Regex> = OnceLock::new();

pub struct AndroidIdDetector;

impl PiiDetector for AndroidIdDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::AndroidId
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = AID_RE.get_or_init(|| {
            Regex::new(r"\b[0-9a-fA-F]{16}\b").unwrap()
        });
        regex_matches(re, text, PiiCategory::AndroidId)
    }
}

// ---------------------------------------------------------------------------
// JWT detector
// ---------------------------------------------------------------------------

static JWT_RE: OnceLock<Regex> = OnceLock::new();

pub struct JwtDetector;

impl PiiDetector for JwtDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Jwt
    }
    fn quick_screen(&self, text: &str) -> bool {
        text.contains("eyJ")
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = JWT_RE.get_or_init(|| {
            Regex::new(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}=*").unwrap()
        });
        regex_matches(re, text, PiiCategory::Jwt)
    }
}

// ---------------------------------------------------------------------------
// API key detector (AWS, GitHub, Stripe, Google, Slack)
// ---------------------------------------------------------------------------

// All five API key patterns combined into one DFA — one scan instead of five.
// The regex crate compiles alternations into a single DFA that explores all branches
// simultaneously, making this as fast as the fastest individual pattern.
static API_KEY_RE: OnceLock<Regex> = OnceLock::new();

pub struct ApiKeyDetector;

impl PiiDetector for ApiKeyDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::ApiKey
    }
    fn quick_screen(&self, text: &str) -> bool {
        text.contains("AKIA")
            || text.contains("ghp_")
            || text.contains("sk_live")
            || text.contains("sk_test")
            || text.contains("AIza")
            || text.contains("xox")
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = API_KEY_RE.get_or_init(|| {
            Regex::new(
                r"\bAKIA[0-9A-Z]{16}\b|\bghp_[0-9a-zA-Z]{36}\b|\bsk_(?:live|test)_[0-9a-zA-Z]{24,99}\b|\bAIza[0-9A-Za-z_\-]{35}\b|\bxox[pboas]-[0-9a-zA-Z\-]{10,99}\b",
            )
            .unwrap()
        });
        regex_matches(re, text, PiiCategory::ApiKey)
    }
}

// ---------------------------------------------------------------------------
// Bearer token detector
// ---------------------------------------------------------------------------

static BEARER_RE: OnceLock<Regex> = OnceLock::new();

pub struct BearerTokenDetector;

impl PiiDetector for BearerTokenDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::BearerToken
    }
    fn quick_screen(&self, text: &str) -> bool {
        // Avoid to_ascii_lowercase() — it allocates on every call.
        // "Bearer" (title case) is the HTTP standard; include common variants explicitly.
        text.contains("Bearer") || text.contains("bearer") || text.contains("BEARER")
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = BEARER_RE.get_or_init(|| {
            Regex::new(r"(?i)Bearer\s+[A-Za-z0-9\-_~+/]{32,}").unwrap()
        });
        regex_matches(re, text, PiiCategory::BearerToken)
    }
}

// ---------------------------------------------------------------------------
// Google Advertising ID detector
// ---------------------------------------------------------------------------

static GAID_RE: OnceLock<Regex> = OnceLock::new();

pub struct GaidDetector;

impl PiiDetector for GaidDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Gaid
    }
    fn quick_screen(&self, text: &str) -> bool {
        // The regex is (?i) but contains() is case-sensitive; cover common casings.
        text.contains("gaid") || text.contains("GAID")
            || text.contains("advertising_id") || text.contains("ADVERTISING_ID")
            || text.contains("google_ad_id") || text.contains("GOOGLE_AD_ID")
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = GAID_RE.get_or_init(|| {
            Regex::new(r"(?i)(?:gaid|advertising_id|google_ad_id)\s*[=:]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})").unwrap()
        });
        capture_group1_matches(re, text, PiiCategory::Gaid)
    }
}

// ---------------------------------------------------------------------------
// Session ID / cookie detector
// ---------------------------------------------------------------------------

static SESSION_ID_RE: OnceLock<Regex> = OnceLock::new();

pub struct SessionIdDetector;

impl PiiDetector for SessionIdDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::SessionId
    }
    fn quick_screen(&self, text: &str) -> bool {
        text.contains("session") || text.contains("jsessionid") || text.contains("phpsessid")
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = SESSION_ID_RE.get_or_init(|| {
            Regex::new(r"(?i)(?:session_id|sessionid|jsessionid|phpsessid)\s*[=:]\s*([a-zA-Z0-9]{20,})").unwrap()
        });
        capture_group1_matches(re, text, PiiCategory::SessionId)
    }
}

// ---------------------------------------------------------------------------
// URL credentials detector
// ---------------------------------------------------------------------------

static URL_CRED_RE: OnceLock<Regex> = OnceLock::new();

pub struct UrlCredentialsDetector;

impl PiiDetector for UrlCredentialsDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::UrlCredentials
    }
    fn quick_screen(&self, text: &str) -> bool {
        text.contains("://") && text.contains('@')
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = URL_CRED_RE.get_or_init(|| {
            Regex::new(r"(?i)(?:https?|postgres|mysql|mongodb|redis|ftp|smtp|amqp|s3)://[^\s:@/]+:[^\s:@/]+@[^\s/]+").unwrap()
        });
        regex_matches(re, text, PiiCategory::UrlCredentials)
    }
}

// ---------------------------------------------------------------------------
// Custom regex detector
// ---------------------------------------------------------------------------

pub struct CustomDetector {
    regex: Regex,
    category: PiiCategory,
}

impl CustomDetector {
    pub fn new(pattern: &str) -> Result<Self, String> {
        Self::with_category(pattern, PiiCategory::Custom)
    }

    pub fn with_category(pattern: &str, category: PiiCategory) -> Result<Self, String> {
        Regex::new(pattern)
            .map(|regex| Self { regex, category })
            .map_err(|e| e.to_string())
    }
}

impl PiiDetector for CustomDetector {
    fn category(&self) -> PiiCategory {
        self.category
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        regex_matches(&self.regex, text, self.category)
    }
}

// ---------------------------------------------------------------------------
// Build the default detector set
// ---------------------------------------------------------------------------

pub fn default_detectors() -> Vec<Box<dyn PiiDetector>> {
    vec![
        Box::new(EmailDetector),
        Box::new(MacDetector),              // MAC before IPv4 — more specific
        Box::new(Ipv4Detector),
        Box::new(Ipv6Detector),
        Box::new(ImeiDetector),
        Box::new(AndroidIdDetector),        // after IMEI (both hex-ish)
        Box::new(SerialDetector),
        Box::new(BearerTokenDetector),      // keyword-anchored — before JWT
        Box::new(JwtDetector),
        Box::new(ApiKeyDetector),
        Box::new(GaidDetector),
        Box::new(SessionIdDetector),
        Box::new(UrlCredentialsDetector),
        // PhoneDetector excluded — off by default (tier3)
    ]
}
