//! The single error type every service function returns.
//!
//! Both transports adapt it: commands keep their `Result<T, String>` signature
//! via [`From<ServiceError> for String`], and the MCP bridge maps
//! [`ServiceError::http_status`] + [`ServiceError::code`] into a real HTTP
//! status with a `{ "error": { "code", "message" } }` body.
//!
//! **Message compatibility rule:** where an error message already exists in the
//! command or bridge layer today, [`ServiceError::message`] must reproduce it
//! verbatim — the frontend and the MCP server both string-match some of them.
//! The constructors below exist so a caller cannot accidentally invent a new
//! spelling of a message that already has one (`Session '{id}' not found`,
//! `{name} lock poisoned`).

use std::fmt;

/// Error returned by every `services::*` function.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    /// The addressed entity does not exist. `404`.
    NotFound(String),
    /// Caller-supplied input was malformed or unusable. `400`.
    InvalidArg {
        /// Machine-readable discriminant, e.g. `INVALID_ARGUMENT`, `INVALID_PATH`.
        code: &'static str,
        message: String,
    },
    /// The caller is not permitted to perform this operation. `403`.
    Forbidden {
        /// Machine-readable discriminant, e.g. `NOT_ALLOWED`.
        code: &'static str,
        message: String,
    },
    /// The operation conflicts with current state. `409`.
    Conflict(String),
    /// An `AppState` mutex was poisoned by a panicking writer. `500`.
    /// The payload is the lock name, so the rendered message matches
    /// `commands::lock_or_err`'s `"{name} lock poisoned"` byte for byte.
    LockPoisoned(&'static str),
    /// The operation was cancelled by the caller (or a stop signal). `499`.
    Cancelled,
    /// Anything else. `500`.
    Internal(String),
}

/// Default code for [`ServiceError::InvalidArg`] when the caller has no more
/// specific one.
pub const INVALID_ARGUMENT: &str = "INVALID_ARGUMENT";
/// Code used by the open-file gate for a malformed path.
pub const INVALID_PATH: &str = "INVALID_PATH";
/// Code used by the open-file gate (and every other caller-identity gate) for a
/// refusal. Matches the bridge's existing `NOT_ALLOWED` contract.
pub const NOT_ALLOWED: &str = "NOT_ALLOWED";

impl ServiceError {
    /// `Session '{id}' not found` — the dominant spelling across `commands/*`.
    /// Use this rather than hand-rolling the string.
    pub fn session_not_found(session_id: &str) -> Self {
        ServiceError::NotFound(format!("Session '{session_id}' not found"))
    }

    /// A generic bad-argument error carrying [`INVALID_ARGUMENT`].
    pub fn invalid_arg(message: impl Into<String>) -> Self {
        ServiceError::InvalidArg {
            code: INVALID_ARGUMENT,
            message: message.into(),
        }
    }

    /// A refusal carrying [`NOT_ALLOWED`].
    pub fn not_allowed(message: impl Into<String>) -> Self {
        ServiceError::Forbidden {
            code: NOT_ALLOWED,
            message: message.into(),
        }
    }

    /// Human-readable message. Reproduces today's strings verbatim.
    pub fn message(&self) -> String {
        match self {
            ServiceError::NotFound(m) | ServiceError::Conflict(m) | ServiceError::Internal(m) => {
                m.clone()
            }
            ServiceError::InvalidArg { message, .. }
            | ServiceError::Forbidden { message, .. } => message.clone(),
            // Byte-identical to `commands::lock_or_err`.
            ServiceError::LockPoisoned(name) => format!("{name} lock poisoned"),
            ServiceError::Cancelled => "cancelled".to_string(),
        }
    }

    /// Stable machine-readable discriminant for MCP clients.
    pub fn code(&self) -> &'static str {
        match self {
            ServiceError::NotFound(_) => "NOT_FOUND",
            ServiceError::InvalidArg { code, .. } | ServiceError::Forbidden { code, .. } => code,
            ServiceError::Conflict(_) => "CONFLICT",
            ServiceError::LockPoisoned(_) => "LOCK_POISONED",
            ServiceError::Cancelled => "CANCELLED",
            ServiceError::Internal(_) => "INTERNAL",
        }
    }

    /// HTTP status the bridge should answer with. Returned as a bare `u16` so
    /// `services/` stays free of any transport crate.
    pub fn http_status(&self) -> u16 {
        match self {
            ServiceError::NotFound(_) => 404,
            ServiceError::InvalidArg { .. } => 400,
            ServiceError::Forbidden { .. } => 403,
            ServiceError::Conflict(_) => 409,
            // 499 "Client Closed Request" — nginx's de-facto code, which the
            // MCP server already treats as a non-error abort.
            ServiceError::Cancelled => 499,
            ServiceError::LockPoisoned(_) | ServiceError::Internal(_) => 500,
        }
    }
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ServiceError {}

/// Commands keep their `Result<T, String>` signature: `service_fn(..)?` inside a
/// `#[tauri::command]` converts through this impl and the frontend sees exactly
/// the string it sees today.
impl From<ServiceError> for String {
    fn from(e: ServiceError) -> String {
        e.message()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_poisoned_message_matches_lock_or_err() {
        // `commands::lock_or_err` formats exactly this. Both transports show
        // the same string for the same poisoned lock.
        let e = ServiceError::LockPoisoned("sessions");
        assert_eq!(e.message(), "sessions lock poisoned");

        // Prove it against the real `lock_or_err` on a genuinely poisoned lock
        // rather than against a hand-copied literal.
        let m = std::sync::Arc::new(std::sync::Mutex::new(0u8));
        let poisoner = std::sync::Arc::clone(&m);
        let joined = std::thread::spawn(move || {
            let _g = poisoner.lock().expect("lock not yet poisoned");
            panic!("simulated writer panic");
        })
        .join();
        assert!(joined.is_err());
        let from_commands = crate::commands::lock_or_err(&m, "sessions")
            .expect_err("poisoned lock must error");
        assert_eq!(e.message(), from_commands);
    }

    #[test]
    fn session_not_found_uses_the_dominant_spelling() {
        assert_eq!(
            ServiceError::session_not_found("abc").message(),
            "Session 'abc' not found"
        );
    }

    #[test]
    fn codes_and_statuses() {
        assert_eq!(ServiceError::NotFound("x".into()).code(), "NOT_FOUND");
        assert_eq!(ServiceError::NotFound("x".into()).http_status(), 404);
        assert_eq!(ServiceError::invalid_arg("x").code(), "INVALID_ARGUMENT");
        assert_eq!(ServiceError::invalid_arg("x").http_status(), 400);
        assert_eq!(ServiceError::not_allowed("x").code(), "NOT_ALLOWED");
        assert_eq!(ServiceError::not_allowed("x").http_status(), 403);
        assert_eq!(ServiceError::Conflict("x".into()).code(), "CONFLICT");
        assert_eq!(ServiceError::Conflict("x".into()).http_status(), 409);
        assert_eq!(ServiceError::LockPoisoned("s").code(), "LOCK_POISONED");
        assert_eq!(ServiceError::LockPoisoned("s").http_status(), 500);
        assert_eq!(ServiceError::Cancelled.code(), "CANCELLED");
        assert_eq!(ServiceError::Cancelled.http_status(), 499);
        assert_eq!(ServiceError::Internal("x".into()).code(), "INTERNAL");
        assert_eq!(ServiceError::Internal("x".into()).http_status(), 500);
    }

    #[test]
    fn invalid_path_keeps_its_own_code() {
        let e = ServiceError::InvalidArg {
            code: INVALID_PATH,
            message: "relative paths are not allowed".to_string(),
        };
        assert_eq!(e.code(), "INVALID_PATH");
        assert_eq!(e.http_status(), 400);
    }

    #[test]
    fn into_string_yields_the_message() {
        let s: String = ServiceError::session_not_found("s1").into();
        assert_eq!(s, "Session 's1' not found");
    }

    #[test]
    fn display_matches_message() {
        let e = ServiceError::Internal("boom".into());
        assert_eq!(e.to_string(), e.message());
    }
}
