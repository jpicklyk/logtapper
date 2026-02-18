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
        let mut buf = String::new();

        'outer: while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Stream read error: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));

            // Process all complete newline-terminated lines in the buffer.
            loop {
                match buf.find('\n') {
                    None => break,
                    Some(pos) => {
                        let raw = buf[..pos].trim_end_matches('\r').to_string();
                        buf.drain(..pos + 1);

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
                                        .error
                                        .map(|e| e.to_string())
                                        .unwrap_or_else(|| "Unknown error".into());
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
