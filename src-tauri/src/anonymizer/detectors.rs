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
            // Full form: 8 groups of 4 hex digits separated by colons.
            // Compressed form: requires at least one hex group before "::".
            // This avoids matching lone IPv4 port suffixes like ":8080".
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
// Phone number detector
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
            // "serial=XXXXXX" or "SN: XXXXXX" patterns; 6-20 alphanum chars
            Regex::new(r"(?i)(?:serial\s*[=:]\s*|SN[:\s])([A-Za-z0-9]{6,20})").unwrap()
        });
        re.captures_iter(text)
            .map(|cap| {
                let m = cap.get(1).unwrap();
                PiiMatch {
                    range: m.start()..m.end(),
                    category: PiiCategory::Serial,
                    raw_value: m.as_str().to_string(),
                }
            })
            .collect()
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
            // Exactly 16 hex chars, word-boundary delimited
            Regex::new(r"\b[0-9a-fA-F]{16}\b").unwrap()
        });
        regex_matches(re, text, PiiCategory::AndroidId)
    }
}

// ---------------------------------------------------------------------------
// Custom regex detector
// ---------------------------------------------------------------------------

pub struct CustomDetector {
    regex: Regex,
}

impl CustomDetector {
    pub fn new(pattern: &str) -> Result<Self, String> {
        Regex::new(pattern)
            .map(|regex| Self { regex })
            .map_err(|e| e.to_string())
    }
}

impl PiiDetector for CustomDetector {
    fn category(&self) -> PiiCategory {
        PiiCategory::Custom
    }
    fn find_all(&self, text: &str) -> Vec<PiiMatch> {
        regex_matches(&self.regex, text, PiiCategory::Custom)
    }
}

// ---------------------------------------------------------------------------
// Build the default detector set
// ---------------------------------------------------------------------------

pub fn default_detectors() -> Vec<Box<dyn PiiDetector>> {
    vec![
        Box::new(EmailDetector),
        Box::new(MacDetector),       // before IPv4 — MAC is more specific
        Box::new(Ipv4Detector),
        Box::new(Ipv6Detector),
        Box::new(ImeiDetector),
        Box::new(AndroidIdDetector), // after IMEI (both hex-ish)
        Box::new(SerialDetector),
        // Phone is noisy — excluded from default set; callers can add if desired.
    ]
}
