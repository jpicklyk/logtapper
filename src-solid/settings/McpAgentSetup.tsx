/** @jsxImportSource solid-js */
import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { writeClipboard } from '@viewport/copyText';
import type { SettingsStore } from './settingsStore';
import styles from './settings.module.css';

// ── MCP agent setup ─────────────────────────────────────────────────────────
//
// One server, three ways to reach it:
//
//   HTTP (any harness) — while the bridge is on, the app runs its own MCP
//     server at a fixed localhost URL. Claude Code, Cursor, VS Code and every
//     other client that speaks Streamable HTTP connects there. Nothing to
//     install, nothing to update: the server is the one shipped with the app.
//   Claude Desktop — installs the bundled .mcpb, a small relay that forwards
//     to that URL. Claude Desktop extensions are stdio-only, and its cloud
//     connectors cannot reach localhost, so the relay is the adapter for that
//     one host. Installed once; it does not change with LogTapper releases.
//   stdio by path — the `logtapper-mcp` binary launched directly, for clients
//     that cannot do HTTP. The path differs per install, which is why the app
//     surfaces it here rather than documenting it.
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

/** `claude mcp add` for the HTTP endpoint — no path, so no quoting concerns. */
export function claudeCodeHttpCommandFor(url: string): string {
  return `claude mcp add --transport http --scope user logtapper ${url}`;
}

/** The `mcpServers` shape Cursor, Windsurf and Claude-style configs share for a URL server. */
export function httpConfigFor(url: string): string {
  return JSON.stringify({ mcpServers: { logtapper: { url } } }, null, 2);
}

type CopyKey = 'url' | 'http-code' | 'http-json' | 'path' | 'code' | 'desktop';

export interface McpAgentSetupProps {
  store: SettingsStore;
}

export function McpAgentSetup(props: McpAgentSetupProps) {
  const [copied, setCopied] = createSignal<CopyKey | null>(null);
  const [note, setNote] = createSignal<string | null>(null);
  // The port field edits a draft; Apply pushes it to the store, whose rejection
  // (validation, or the backend refusing) lands in the panel's error banner.
  const [portDraft, setPortDraft] = createSignal<string>('');
  // Follow the store's port (initially, and after an Apply lands) so the draft
  // never shows a stale number — a tracked scope, so the reactivity rule holds.
  createEffect(() => setPortDraft(String(props.store.mcpHttpPort())));
  const draftPort = (): number | null => {
    const n = Number(portDraft());
    return /^\d+$/.test(portDraft()) && Number.isInteger(n) ? n : null;
  };
  const portDirty = (): boolean => draftPort() !== props.store.mcpHttpPort();
  const applyPort = (): void => {
    const port = draftPort();
    if (port === null) return;
    const mcp = props.store;
    mcp.setMcpHttpPort(port).catch(() => undefined); // rejection already recorded in store.error()
  };
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

  const PortEditor = () => (
    <div class={styles.mcpAgentPathRow}>
      <label class={styles.labelHint} for="mcp-http-port">Port</label>
      <input
        id="mcp-http-port"
        class={styles.input}
        type="number"
        inputmode="numeric"
        min="1024"
        max="65535"
        value={portDraft()}
        onInput={(e) => setPortDraft(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && portDirty() && draftPort() !== null) applyPort(); }}
      />
      <button type="button" class={styles.linkBtn} disabled={!portDirty() || draftPort() === null} onClick={applyPort}>
        Apply port
      </button>
    </div>
  );

  return (
    <Show when={props.store.mcpAgentResolved()}>
      <div class={styles.mcpAgentSetup} data-testid="mcp-agent-setup">
        <div class={styles.mcpAgentSetupTitle}>Connect an AI agent</div>

        <div class={styles.mcpAgentClient}>
          <div class={styles.mcpAgentClientName}>Any MCP client (HTTP)</div>
          <Show
            when={props.store.mcpHttpEndpoint()}
            fallback={
              <Show
                when={props.store.mcpSidecarPath()}
                fallback={
                  <div class={styles.labelHint}>
                    No bundled server binary found — expected in installed builds only. From a
                    source checkout, run
                    {' '}
                    <code class={styles.mcpAgentCode}>node --experimental-strip-types mcp-server/src/index.ts --http 40405</code>
                    {' '}
                    and connect to
                    {' '}
                    <code class={styles.mcpAgentCode}>http://127.0.0.1:40405/mcp</code>.
                    See docs/mcp for the full setup guide.
                  </div>
                }
              >
                <div class={styles.labelHint}>
                  {props.store.mcpHttpError()
                    ? `The MCP server did not start: ${props.store.mcpHttpError()}. If the port is taken, choose another below.`
                    : props.store.mcpStatus()?.running
                      ? 'Starting the MCP server…'
                      : 'Enable the MCP bridge above — the HTTP endpoint starts and stops with it.'}
                </div>
                <PortEditor />
              </Show>
            }
          >
            {(url) => (
              <>
                <div class={styles.labelHint}>
                  Point your client at this URL. It always reaches the server that shipped with this
                  LogTapper, so there is nothing to reinstall after an update.
                </div>
                <div class={styles.mcpAgentPathRow}>
                  <code class={styles.mcpAgentPath} title={url()}>
                    {url()}
                  </code>
                  <button type="button" class={styles.linkBtn} onClick={() => copy('url', url())}>
                    {copied() === 'url' ? 'Copied' : 'Copy URL'}
                  </button>
                </div>
                <PortEditor />
                <div class={styles.mcpAgentActions}>
                  <button
                    type="button"
                    class={styles.button}
                    title="claude mcp add --transport http --scope user logtapper <url>"
                    onClick={() => copy('http-code', claudeCodeHttpCommandFor(url()))}
                  >
                    {copied() === 'http-code' ? 'Copied' : 'Copy claude mcp add command'}
                  </button>
                  <button
                    type="button"
                    class={styles.linkBtn}
                    title="mcpServers block with a url — Cursor, Windsurf and similar"
                    onClick={() => copy('http-json', httpConfigFor(url()))}
                  >
                    {copied() === 'http-json' ? 'Copied' : 'Copy JSON config'}
                  </button>
                </div>
              </>
            )}
          </Show>
        </div>

        <Show when={props.store.mcpBundleInfo()}>
          {(bundle) => (
            <div class={styles.mcpAgentClient}>
              <div class={styles.mcpAgentClientName}>Claude Desktop</div>
              <div class={styles.labelHint}>
                {bundle().installable
                  ? 'Installs a small relay extension that forwards to the URL above. Install it once — it does not change with LogTapper releases.'
                  : 'Save the relay extension, then install it in Claude Desktop: Developer → Extensions → Install Extension… Install it once — it does not change with LogTapper releases.'}
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

        <Show when={props.store.mcpSidecarPath()}>
          {(sidecarPath) => (
            <div class={styles.mcpAgentClient}>
              <div class={styles.mcpAgentClientName}>Launch by path (stdio)</div>
              <div class={styles.labelHint}>
                For clients that cannot connect over HTTP. The path changes with the install
                location, so re-register after moving LogTapper.
              </div>
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
                  class={styles.linkBtn}
                  title="claude mcp add logtapper --scope user -- <path>"
                  onClick={() => copy('code', claudeCodeCommandFor(sidecarPath()))}
                >
                  {copied() === 'code' ? 'Copied' : 'Copy claude mcp add command (by path)'}
                </button>
                <button
                  type="button"
                  class={styles.linkBtn}
                  title="mcpServers block with a command — claude_desktop_config.json and similar"
                  onClick={() => copy('desktop', desktopConfigFor(sidecarPath()))}
                >
                  {copied() === 'desktop' ? 'Copied' : 'Copy JSON config (by path)'}
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Show>
  );
}

export default McpAgentSetup;
