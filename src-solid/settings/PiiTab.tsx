/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { anonymizerModeDescription, anonymizerModeLabel } from '../analyzers';
import type { SettingsStore } from './settingsStore';
import styles from './settings.module.css';
export interface PiiTabProps { store: SettingsStore }
export function PiiTab(props: PiiTabProps) {
  const mode = createMemo(() => props.store.anonymizerMode());
  const off = createMemo(() => mode() === 'none');
  const [testText, setTestText] = createSignal('');
  const [testError, setTestError] = createSignal<string | null>(null);
  const [sessionId, setSessionId] = createSignal('');
  const [mappingsError, setMappingsError] = createSignal<string | null>(null);
  onMount(() => props.store.refreshAnonymizerConfig());
  const handleTest = (): void => {
    setTestError(null);
    props.store.runAnonymizerTest(testText()).catch((e: unknown) => setTestError(String(e)));
  };
  const handleLoadMappings = (): void => {
    const id = sessionId().trim();
    if (!id) return;
    setMappingsError(null);
    props.store.refreshPiiMappings(id).catch((e: unknown) => setMappingsError(String(e)));
  };
  return (
    <div class={styles.panel} data-testid="pii-tab">
      {/* Read-only mirror: the mode has ONE writer in the UI, the pinned PII
          card on the Analyzers panel, so two surfaces never disagree about
          what the user set. Same words as that card's description line. */}
      <div class={styles.section}>
        <div class={styles.sectionTitle}>Anonymizer</div>
        <div class={styles.row}>
          <span data-testid="pii-mode-line" class={off() ? styles.warningText : undefined}>
            Mode: <strong>{anonymizerModeLabel(mode())}</strong> — {anonymizerModeDescription(mode())}
          </span>
        </div>
        <span class={styles.labelHint}>Change it on the Analyzers panel (the PII Anonymizer card).</span>
      </div>
      <Show when={props.store.anonymizerConfig()} fallback={<span class={styles.labelHint}>Loading configuration…</span>}>
        {(config) => (
          <div class={styles.section}>
            <div class={styles.sectionTitle}>Detectors</div>
            <span class={styles.labelHint}>Which PII patterns are found; applies to future pipeline runs and exports.</span>
            <Show when={off()}>
              <span class={styles.warningText} data-testid="pii-off-hint">
                The anonymizer is off — detectors take effect again once the mode is All or External.
              </span>
            </Show>
            <For each={config().detectors}>
              {(d) => (
                <div class={styles.row}>
                  <span>
                    <input type="checkbox" checked={d.enabled} onChange={(e) => void props.store.toggleDetector(d.id, e.currentTarget.checked)} />
                    {' '}{d.label} <span class={styles.labelHint}>({d.tier}, {d.patterns.length} pattern{d.patterns.length !== 1 ? 's' : ''})</span>
                  </span>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
      <div class={styles.section}>
        <div class={styles.sectionTitle}>Test Anonymizer</div>
        <Show when={off()}>
          <span class={styles.warningText}>
            The anonymizer is off — this shows what the detectors <em>would</em> redact.
          </span>
        </Show>
        <textarea class={styles.input} rows={3} placeholder="Paste a log line to see what would be redacted…" value={testText()} onInput={(e) => setTestText(e.currentTarget.value)} />
        <button type="button" class={styles.button} disabled={!testText().trim()} onClick={handleTest}>Test</button>
        <Show when={testError()}><p class={styles.error} role="alert">{testError()}</p></Show>
        <Show when={props.store.testResult()}>
          {(result) => (
            <>
              <code data-testid="anonymizer-result">{result().anonymized}</code>
              <Show when={result().replacements.length > 0}>
                <table class={styles.table}>
                  <thead><tr><th>Token</th><th>Category</th><th>Original</th></tr></thead>
                  <tbody>
                    <For each={result().replacements}>
                      {(r) => <tr><td><code>{r.token}</code></td><td>{r.category}</td><td><code>{r.original}</code></td></tr>}
                    </For>
                  </tbody>
                </table>
              </Show>
            </>
          )}
        </Show>
      </div>
      <div class={styles.section}>
        <div class={styles.sectionTitle}>PII Mappings</div>
        <span class={styles.labelHint}>Token → original value mappings recorded for a session.</span>
        <div class={styles.addRow}>
          <input class={styles.input} type="text" placeholder="Session id" value={sessionId()} onInput={(e) => setSessionId(e.currentTarget.value)} />
          <button type="button" class={styles.button} onClick={handleLoadMappings}>Load</button>
        </div>
        <Show when={mappingsError()}><p class={styles.error} role="alert">{mappingsError()}</p></Show>
        <Show when={Object.keys(props.store.piiMappings()).length > 0}>
          <table class={styles.table}>
            <thead><tr><th>Token</th><th>Original</th></tr></thead>
            <tbody>
              <For each={Object.entries(props.store.piiMappings())}>
                {([token, original]) => <tr><td><code>{token}</code></td><td><code>{original}</code></td></tr>}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </div>
  );
}
