/** @jsxImportSource solid-js */
import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { writeClipboard } from '@viewport/copyText';
import type { SettingsStore } from './settingsStore';
import styles from './settings.module.css';

// ── MCP agent setup (C1, ported from the React SettingsPanel) ──────────────
//
// Two clients, two mechanisms:
//
//   Claude Desktop — installs the bundled .mcpb, which carries its own copy of
//     the server. Nothing here depends on where LogTapper was installed.
//   Claude Code — launches the `logtapper-mcp` sidecar by absolute path, so the
//     path has to be discoverable. The app is the only thing that reliably
//     knows it, which is why it is surfaced here rather than documented.
//
// Failures (install/save rejecting) are NOT shown as a local note — they go
// through `store.installMcpBundle`/`store.saveMcpBundle`, which route the
// rejection into `settingsStore.error()`, already rendered by
// `SettingsPanel`'s error banner. This block's own `note` signal is only ever
// a success message, so nothing here ever puts an unrendered `String(e)` into
// the DOM (task-scope, review Theme 4).

/** Claude Desktop reads JSON, so backslashes need escaping — JSON.stringify does it. */
export function desktopConfigFor(path: string): string {
  return JSON.stringify({ mcpServers: { logtapper: { command: path } } }, null, 2);
}

export function claudeCodeCommandFor(path: string): string {
  return `claude mcp add logtapper --scope user -- "${path}"`;
}

type CopyKey = 'path' | 'code' | 'desktop';

export interface McpAgentSetupProps {
  store: SettingsStore;
}

export function McpAgentSetup(props: McpAgentSetupProps) {
  const [copied, setCopied] = createSignal<CopyKey | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => props.store.refreshMcpAgentSetup());

  onCleanup(() => {
    if (copyTimer) clearTimeout(copyTimer);
    if (noteTimer) clearTimeout(noteTimer);
  });

  const copy = (key: CopyKey, text: string): void => {
    writeClipboard(text);
    setCopied(key);
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopied(null), 1500);
  };

  const showNote = (message: string): void => {
    setNote(message);
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => setNote(null), 6000);
  };

  const handleInstall = (): void => {
    // `props.store` is read here, synchronously, at the top of the event handler
    // — the rest of the closure captures the plain `mcp` reference rather than
    // reaching through `props` again inside the `.then()` callback below, which
    // keeps eslint-plugin-solid's reactivity rule satisfied.
    const mcp = props.store;
    mcp
      .installMcpBundle()
      .then(() => showNote('Opened the bundle — confirm the install in Claude Desktop. Nothing happened? Use Save bundle instead.'))
      .catch(() => undefined); // rejection already recorded in store.error()
  };

  const handleSave = (): void => {
    const mcp = props.store;
    saveFileDialog({
      defaultPath: 'logtapper.mcpb',
      filters: [{ name: 'MCP Bundle', extensions: ['mcpb'] }],
    })
      .then((dest) => {
        if (!dest) return;
        return mcp
          .saveMcpBundle(dest)
          .then(() => showNote(`Saved to ${dest} — in Claude Desktop, install it with Developer → Extensions → Install Extension…`));
      })
      .catch(() => undefined); // rejection already recorded in store.error()
  };

  return (
    <Show when={props.store.mcpAgentResolved()}>
      <div class={styles.mcpAgentSetup} data-testid="mcp-agent-setup">
        <div class={styles.mcpAgentSetupTitle}>Connect an AI agent</div>

        <Show when={props.store.mcpBundleInfo()}>
          {(bundle) => (
            <div class={styles.mcpAgentClient}>
              <div class={styles.mcpAgentClientName}>Claude Desktop</div>
              <div class={styles.labelHint}>
                {bundle().installable
                  ? 'Installs a self-contained extension — no file paths to configure.'
                  : 'Save the extension bundle, then install it in Claude Desktop: Developer → Extensions → Install Extension…'}
              </div>
              <div class={styles.mcpAgentActions}>
                <Show when={bundle().installable}>
                  <button type="button" class={styles.button} onClick={handleInstall}>
                    Install extension
                  </button>
                </Show>
                <button type="button" class={styles.linkBtn} onClick={handleSave}>
                  Save bundle…
                </button>
              </div>
              <Show when={note()}>{(message) => <div class={styles.mcpAgentNote}>{message()}</div>}</Show>
            </div>
          )}
        </Show>

        <div class={styles.mcpAgentClient}>
          <div class={styles.mcpAgentClientName}>Claude Code</div>
          <Show
            when={props.store.mcpSidecarPath()}
            fallback={
              <div class={styles.labelHint}>
                No bundled server binary found — expected in installed builds only. From a
                source checkout, run
                {' '}
                <code class={styles.mcpAgentCode}>node --experimental-strip-types mcp-server/src/index.ts</code>.
                See docs/mcp for the full setup guide.
              </div>
            }
          >
            {(sidecarPath) => (
              <>
                <div class={styles.labelHint}>Register the bundled server, then start a new session.</div>
                <div class={styles.mcpAgentPathRow}>
                  <code class={styles.mcpAgentPath} title={sidecarPath()}>
                    {sidecarPath()}
                  </code>
                  <button type="button" class={styles.linkBtn} onClick={() => copy('path', sidecarPath())}>
                    {copied() === 'path' ? 'Copied' : 'Copy path'}
                  </button>
                </div>
                <div class={styles.mcpAgentActions}>
                  <button
                    type="button"
                    class={styles.button}
                    title="claude mcp add logtapper --scope user -- <path>"
                    onClick={() => copy('code', claudeCodeCommandFor(sidecarPath()))}
                  >
                    {copied() === 'code' ? 'Copied' : 'Copy claude mcp add command'}
                  </button>
                  <button
                    type="button"
                    class={styles.linkBtn}
                    title="JSON block for claude_desktop_config.json"
                    onClick={() => copy('desktop', desktopConfigFor(sidecarPath()))}
                  >
                    {copied() === 'desktop' ? 'Copied' : 'Copy JSON config'}
                  </button>
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}

export default McpAgentSetup;
