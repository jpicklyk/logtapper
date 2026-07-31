use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Anthropic Messages API types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Streaming SSE parse helpers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct StreamEventEnvelope {
    #[serde(rename = "type")]
    event_type: String,
    delta: Option<TextDelta>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct TextDelta {
    #[serde(rename = "type")]
    delta_type: String,
    text: Option<String>,
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MessagesResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri event payload emitted for every streaming token
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStreamEvent {
    /// "text" | "done" | "error"
    pub kind: String,
    pub text: Option<String>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// SSE byte-buffer line extraction
// ---------------------------------------------------------------------------

/// Drain every complete newline-terminated line out of a raw byte buffer,
/// decoding each as UTF-8 and stripping a trailing `\r`/`\n`. Any trailing
/// bytes that don't yet form a complete line (including a multi-byte UTF-8
/// character split across two chunk boundaries) are left in `buf` for the
/// next call.
///
/// Splitting on the raw `\n` (0x0A) byte is always safe for UTF-8: every
/// continuation byte and multi-byte lead byte is >= 0x80, so 0x0A can only
/// ever appear as a literal line feed, never as part of a multi-byte
/// character. That's what makes it safe to decode only once a full line's
/// bytes are buffered, instead of decoding each network chunk independently
/// (which corrupts any character split across a chunk boundary into U+FFFD).
fn drain_complete_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    loop {
        let Some(pos) = buf.iter().position(|&b| b == b'\n') else {
            break;
        };
        let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
        let decoded = String::from_utf8_lossy(&line_bytes).into_owned();
        lines.push(decoded.trim_end_matches(['\n', '\r']).to_string());
    }
    lines
}

// ---------------------------------------------------------------------------
// ClaudeClient
// ---------------------------------------------------------------------------

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS: u32 = 8_192;

pub struct ClaudeClient {
    client: Client,
    api_key: String,
    model: String,
}

impl ClaudeClient {
    pub fn new(api_key: String) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
        Ok(Self {
            client,
            api_key,
            model: DEFAULT_MODEL.to_string(),
        })
    }

    /// Stream a conversation, emitting `claude-stream` Tauri events for each
    /// text token. Blocks until the stream ends or an error occurs.
    pub async fn stream_messages(
        &self,
        system: &str,
        messages: &[ChatMessage],
        app: &AppHandle,
    ) -> Result<(), String> {
        let request = MessagesRequest {
            model: &self.model,
            max_tokens: DEFAULT_MAX_TOKENS,
            system,
            messages,
            stream: true,
        };

        let response = self
            .client
            .post(API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("API request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Claude API error {status}: {body}"));
        }

        let mut stream = response.bytes_stream();
        // Raw byte buffer, not a String — chunk boundaries from bytes_stream()
        // are arbitrary TCP/HTTP framing points, not UTF-8 or line boundaries.
        // Decoding each chunk independently (the previous approach) corrupts
        // any multi-byte character split across a chunk boundary. See
        // drain_complete_lines() for the safe accumulate-then-decode approach.
        let mut buf: Vec<u8> = Vec::new();

        'outer: while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
            buf.extend_from_slice(&chunk);

            // Process all complete newline-terminated lines in the buffer.
            for raw in drain_complete_lines(&mut buf) {
                if !raw.starts_with("data: ") {
                    continue;
                }
                let data = &raw["data: ".len()..];

                if data == "[DONE]" {
                    break 'outer;
                }

                if let Ok(env) = serde_json::from_str::<StreamEventEnvelope>(data) {
                    match env.event_type.as_str() {
                        "content_block_delta" => {
                            if let Some(delta) = env.delta {
                                if delta.delta_type == "text_delta" {
                                    if let Some(text) = delta.text {
                                        let _ = app.emit(
                                            "claude-stream",
                                            ClaudeStreamEvent {
                                                kind: "text".into(),
                                                text: Some(text),
                                                error: None,
                                            },
                                        );
                                    }
                                }
                            }
                        }
                        "message_stop" => break 'outer,
                        "error" => {
                            let msg = env
                                .error.map_or_else(|| "Unknown error".into(), |e| e.to_string());
                            let _ = app.emit(
                                "claude-stream",
                                ClaudeStreamEvent {
                                    kind: "error".into(),
                                    text: None,
                                    error: Some(msg.clone()),
                                },
                            );
                            return Err(msg);
                        }
                        _ => {}
                    }
                }
            }
        }

        let _ = app.emit(
            "claude-stream",
            ClaudeStreamEvent {
                kind: "done".into(),
                text: None,
                error: None,
            },
        );

        Ok(())
    }

    /// Non-streaming completion for processor generation.
    pub async fn complete(&self, system: &str, user_message: &str) -> Result<String, String> {
        let messages = [ChatMessage {
            role: "user".into(),
            content: user_message.to_string(),
        }];
        let request = MessagesRequest {
            model: &self.model,
            max_tokens: DEFAULT_MAX_TOKENS,
            system,
            messages: &messages,
            stream: false,
        };

        let response = self
            .client
            .post(API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header(header::CONTENT_TYPE, "application/json")
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("API request failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Claude API error {status}: {body}"));
        }

        let resp: MessagesResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse response: {e}"))?;

        let text: String = resp
            .content
            .into_iter()
            .filter(|b| b.block_type == "text")
            .filter_map(|b| b.text)
            .collect::<Vec<_>>()
            .join("");

        if text.is_empty() {
            Err("Empty response from Claude".into())
        } else {
            Ok(text)
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_complete_lines_holds_back_partial_trailing_line() {
        let mut buf: Vec<u8> = b"data: hello".to_vec();
        let lines = drain_complete_lines(&mut buf);
        assert!(lines.is_empty(), "no newline yet — nothing should be drained");
        assert_eq!(buf, b"data: hello", "partial line must remain buffered");
    }

    #[test]
    fn drain_complete_lines_strips_trailing_cr_and_lf() {
        let mut buf: Vec<u8> = b"data: hello\r\ndata: world\n".to_vec();
        let lines = drain_complete_lines(&mut buf);
        assert_eq!(lines, vec!["data: hello".to_string(), "data: world".to_string()]);
        assert!(buf.is_empty());
    }

    /// Defect 2 regression test: a multi-byte UTF-8 character (the em dash
    /// U+2014, encoded as bytes E2 80 94) split across two separate byte
    /// chunks must decode correctly once both chunks have arrived, instead
    /// of being replaced with U+FFFD.
    #[test]
    fn split_multibyte_char_across_chunks_decodes_correctly() {
        let full = "caf\u{e9} \u{2014} rocks\n".as_bytes().to_vec();
        let split_at = full.iter().position(|&b| b == 0xE2).unwrap() + 1; // cut mid em-dash
        let (chunk1, chunk2) = full.split_at(split_at);

        let mut buf: Vec<u8> = Vec::new();

        // First chunk ends mid-character — no complete line yet, and no
        // decoding must happen until the rest of the character arrives.
        buf.extend_from_slice(chunk1);
        let lines_after_first = drain_complete_lines(&mut buf);
        assert!(lines_after_first.is_empty(), "must not decode a line with a split trailing character");

        // Second chunk completes the character and the line.
        buf.extend_from_slice(chunk2);
        let lines_after_second = drain_complete_lines(&mut buf);
        assert_eq!(lines_after_second.len(), 1);
        let line = &lines_after_second[0];
        assert!(!line.contains('\u{FFFD}'), "must not contain the UTF-8 replacement character, got: {line:?}");
        assert_eq!(line, "caf\u{e9} \u{2014} rocks");
    }

    /// Documents the pre-fix defect: decoding each chunk independently via
    /// `String::from_utf8_lossy(&chunk)` before buffering (the original
    /// stream_messages implementation) corrupts a character split across a
    /// chunk boundary into the replacement character, irrecoverably.
    #[test]
    fn per_chunk_lossy_decode_would_corrupt_a_split_character() {
        let full = "caf\u{e9} \u{2014} rocks\n".as_bytes().to_vec();
        let split_at = full.iter().position(|&b| b == 0xE2).unwrap() + 1;
        let (chunk1, chunk2) = full.split_at(split_at);

        let mut buggy = String::new();
        buggy.push_str(&String::from_utf8_lossy(chunk1));
        buggy.push_str(&String::from_utf8_lossy(chunk2));

        assert!(
            buggy.contains('\u{FFFD}'),
            "reproduces defect 2: independent per-chunk lossy decoding corrupts the split character"
        );
    }

    #[test]
    fn drain_complete_lines_handles_multiple_lines_in_one_chunk() {
        let mut buf: Vec<u8> = b"data: one\ndata: two\ndata: thr".to_vec();
        let lines = drain_complete_lines(&mut buf);
        assert_eq!(lines, vec!["data: one".to_string(), "data: two".to_string()]);
        assert_eq!(buf, b"data: thr", "incomplete trailing line must remain buffered");
    }
}
