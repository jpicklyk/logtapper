use std::collections::HashMap;

use crate::core::session::AnalysisSession;
use crate::processors::interpreter::RunResult;

use super::client::ChatMessage;

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/// Conservative estimate: 4 chars per token.
const CHARS_PER_TOKEN: usize = 4;

/// Leave room for system prompt + response. Roughly 40K tokens for context.
const MAX_CONTEXT_CHARS: usize = 160_000;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT: &str = "\
You are an expert Android log analyst embedded in LogTapper, a desktop tool for \
parsing and analyzing Android log files. You have deep knowledge of Android internals, \
the logcat format, kernel logs, radio logs, ANR traces, and common failure patterns.

Important: All personally identifiable information (PII) in the logs has been \
deterministically pseudonymized before being sent to you. Tokens like <EMAIL-1>, \
<IPv4-1>, <MAC-1> etc. are consistent pseudonyms — the same real value always maps \
to the same token within a session.

Your job is to:
1. Identify patterns, anomalies, and correlations in the provided log data.
2. Diagnose root causes of errors, crashes, or unusual behavior.
3. Suggest actionable next steps or follow-up searches.
4. Be concise but thorough. Use bullet points for lists of findings.";

// ---------------------------------------------------------------------------
// Build analysis context from session state
// ---------------------------------------------------------------------------

pub struct AnalysisContext {
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub estimated_tokens: usize,
}

/// Collects a representative sample of log lines + processor results and
/// formats them as a Claude conversation context.
pub fn build_analysis_context(
    session: &AnalysisSession,
    processor_id: Option<&str>,
    pipeline_results: &HashMap<String, HashMap<String, RunResult>>,
    session_id: &str,
    user_message: &str,
) -> AnalysisContext {
    let mut context_parts: Vec<String> = Vec::new();

    // --- Session overview ---
    let total_lines: usize = session.sources.iter().map(|s| s.total_lines()).sum();
    context_parts.push(format!(
        "## Log Session Overview\n\
         Sources: {}\n\
         Total lines: {}\n",
        session
            .sources
            .iter()
            .map(|s| format!("{} ({})", s.name, s.source_type))
            .collect::<Vec<_>>()
            .join(", "),
        total_lines,
    ));

    // --- Sample log lines (head + tail + middle) ---
    for source in &session.sources {
        let source_lines = source.total_lines();
        if source_lines == 0 {
            continue;
        }

        let mut sample_nums: Vec<usize> = Vec::new();

        // Head: first 40 lines
        let head_count = 40.min(source_lines);
        sample_nums.extend(0..head_count);

        // Tail: last 40 lines
        if source_lines > head_count {
            let tail_start = source_lines.saturating_sub(40);
            for n in tail_start..source_lines {
                if !sample_nums.contains(&n) {
                    sample_nums.push(n);
                }
            }
        }

        // Middle sample: up to 40 evenly spaced
        if source_lines > 80 {
            let step = source_lines / 40;
            for i in 0..40 {
                let n = 40 + i * step;
                if n < tail_start_for(source_lines) && !sample_nums.contains(&n) {
                    sample_nums.push(n);
                }
            }
        }

        sample_nums.sort_unstable();

        let mut lines_text = format!("## Log Lines from {}\n", source.name);
        for &n in &sample_nums {
            if let Some(raw) = source.raw_line(n) {
                lines_text.push_str(&format!("[{}] {}\n", n + 1, raw));
            }
        }

        context_parts.push(lines_text);
    }

    // --- Processor results (if selected) ---
    if let Some(pid) = processor_id {
        if let Some(session_results) = pipeline_results.get(session_id) {
            if let Some(result) = session_results.get(pid) {
                let mut proc_text =
                    format!("## Processor Results: {pid}\n");

                // Variables
                if !result.vars.is_empty() {
                    proc_text.push_str("### Variables\n");
                    for (k, v) in &result.vars {
                        proc_text.push_str(&format!("- {k}: {v}\n"));
                    }
                }

                // First 50 emissions
                if !result.emissions.is_empty() {
                    proc_text.push_str(&format!(
                        "### Emissions ({} total, showing first 50)\n",
                        result.emissions.len()
                    ));
                    for emission in result.emissions.iter().take(50) {
                        if let Ok(json) = serde_json::to_string(emission) {
                        proc_text.push_str(&json);
                        proc_text.push('\n');
                    }
                    }
                }

                // Matched line count
                proc_text.push_str(&format!(
                    "### Matched lines: {}\n",
                    result.matched_line_nums.len()
                ));

                context_parts.push(proc_text);
            }
        }
    }

    // Apply token budget: truncate context to MAX_CONTEXT_CHARS
    let full_context = context_parts.join("\n");
    let context = if full_context.len() > MAX_CONTEXT_CHARS {
        let mut truncated = full_context[..MAX_CONTEXT_CHARS].to_string();
        truncated.push_str("\n\n[Context truncated due to length limits]");
        truncated
    } else {
        full_context
    };

    let estimated_tokens = context.len() / CHARS_PER_TOKEN;

    let user_content = format!("{context}\n\n## User Question\n{user_message}");

    AnalysisContext {
        system: ANALYSIS_SYSTEM_PROMPT.to_string(),
        messages: vec![ChatMessage {
            role: "user".into(),
            content: user_content,
        }],
        estimated_tokens,
    }
}

fn tail_start_for(total: usize) -> usize {
    total.saturating_sub(40)
}
