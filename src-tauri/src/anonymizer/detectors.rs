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

pub struct EmailDetector;

impl PiiDetector for EmailDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Email
    }
    fn quick_screen(&self, text: &str) -> bool {
        text.contains('@')
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        let re = EMAIL_RE
            .get_or_init(|| Regex::new(r"[\w.+\-]+@[\w\-]+\.[\w.\-]+").unwrap());
        regex_matches(re, text, PiiCategory::Email)
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
        text.as_bytes().iter().filter(|&&b| b == b'.').count() >= 3
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
        text.contains("serial") || text.contains("Serial") || text.contains("SN")
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

static API_KEY_AWS_RE: OnceLock<Regex> = OnceLock::new();
static API_KEY_GITHUB_RE: OnceLock<Regex> = OnceLock::new();
static API_KEY_STRIPE_RE: OnceLock<Regex> = OnceLock::new();
static API_KEY_GOOGLE_RE: OnceLock<Regex> = OnceLock::new();
static API_KEY_SLACK_RE: OnceLock<Regex> = OnceLock::new();

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
        let aws = API_KEY_AWS_RE.get_or_init(|| Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap());
        let github = API_KEY_GITHUB_RE.get_or_init(|| Regex::new(r"\bghp_[0-9a-zA-Z]{36}\b").unwrap());
        let stripe = API_KEY_STRIPE_RE.get_or_init(|| Regex::new(r"\bsk_(?:live|test)_[0-9a-zA-Z]{24,99}\b").unwrap());
        let google = API_KEY_GOOGLE_RE.get_or_init(|| Regex::new(r"\bAIza[0-9A-Za-z\-_]{35}\b").unwrap());
        let slack = API_KEY_SLACK_RE.get_or_init(|| Regex::new(r"\bxox[pboas]-[0-9a-zA-Z\-]{10,99}\b").unwrap());
        let patterns: [&Regex; 5] = [aws, github, stripe, google, slack];
        let mut matches = Vec::new();
        for re in &patterns {
            matches.extend(regex_matches(re, text, PiiCategory::ApiKey));
        }
        matches
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
        text.to_ascii_lowercase().contains("bearer")
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
        text.contains("gaid")
            || text.contains("advertising_id")
            || text.contains("google_ad_id")
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
