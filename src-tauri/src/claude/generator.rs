use super::client::ChatMessage;

// ---------------------------------------------------------------------------
// System prompt for processor generation
// ---------------------------------------------------------------------------

pub const GENERATOR_SYSTEM_PROMPT: &str = r#"You are an expert at writing LogTapper processor definitions in YAML.
LogTapper processors analyze Android log files through a declarative pipeline.

## Processor YAML Schema

```yaml
meta:
  id: "unique-processor-id"      # lowercase-hyphenated, unique
  name: "Human Readable Name"
  version: "1.0.0"
  author: "author-name"
  description: "What this processor does"
  tags: ["tag1", "tag2"]

vars:
  - name: variable_name
    type: int | bool | string | float | map | list
    default: <value>
    display: true|false
    label: "UI Label"
    display_as: table|value
    columns: [col1, col2]

pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: ["Tag1", "Tag2"]
      - type: message_contains
        value: "text"
      - type: message_contains_any
        values: ["text1", "text2"]
      - type: message_regex
        pattern: "regex"
      - type: level_min
        level: Warn  # Verbose|Debug|Info|Warn|Error|Fatal

  - stage: extract
    fields:
      - name: field_name
        pattern: "regex with (capture group)"
        cast: int | float | string

  - stage: script
    runtime: rhai
    src: |
      // Rhai script — available: line, fields, vars, history, emit(map)
      // line.tag, line.message, line.level, line.timestamp, line.pid
      // vars persist across all lines; fields are per-line

  - stage: aggregate
    groups:
      - type: count | count_by | min | max | avg | time_bucket
        field: field_name
        group_by: field_name
        interval: "5m"
        label: "Description"

  - stage: output
    views:
      - type: table
        source: emissions | vars
        columns: [col1, col2]
        sort: column_name
      - type: summary
        source: vars
        template: |
          Found {{count}} events.

    charts:
      - id: chart_id
        type: time_series | bar | scatter | histogram | pie | area
        title: "Chart Title"
        source: emissions | vars.var_name
        x: { field: field_name, label: "X Label" }
        y: { field: field_name, label: "Y Label", aggregation: count }
        interactive: true
```

## Rules
- Respond with ONLY valid YAML — no explanation text, no markdown code fences.
- The `meta.id` must be unique and lowercase-hyphenated.
- Filter rules are ANDed together (all must match).
- Use `script` stage only when declarative stages are insufficient.
- Keep processors focused on one specific analysis task.
- Use `display: true` on vars that should appear in the dashboard.
"#;

// ---------------------------------------------------------------------------
// Build the user prompt for processor generation
// ---------------------------------------------------------------------------

pub fn build_generator_prompt(description: &str, sample_lines: &[String]) -> Vec<ChatMessage> {
    let mut prompt = format!(
        "Generate a LogTapper processor YAML for the following task:\n\n{description}\n\n"
    );

    if !sample_lines.is_empty() {
        prompt.push_str("## Sample log lines from the target file:\n");
        for line in sample_lines.iter().take(30) {
            prompt.push_str(line);
            prompt.push('\n');
        }
        prompt.push('\n');
    }

    prompt.push_str(
        "Respond with ONLY the YAML processor definition. No code fences, no explanation.",
    );

    vec![ChatMessage {
        role: "user".into(),
        content: prompt,
    }]
}

// ---------------------------------------------------------------------------
// Extract YAML from Claude's response (handles code-fenced or raw YAML)
// ---------------------------------------------------------------------------

pub fn extract_yaml(response: &str) -> String {
    let trimmed = response.trim();

    // Try to extract from ```yaml ... ``` block
    if let Some(start) = trimmed.find("```yaml") {
        let after = &trimmed[start + 7..];
        if let Some(end) = after.find("```") {
            return after[..end].trim().to_string();
        }
    }

    // Try ``` ... ``` (no language tag)
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        // Skip optional language identifier on same line
        let content_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
        let content = &after[content_start..];
        if let Some(end) = content.find("```") {
            return content[..end].trim().to_string();
        }
    }

    // Assume the whole response is YAML
    trimmed.to_string()
}
