import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { Button } from '../../ui';
import {
  getMcpBundlePath,
  getMcpSidecarPath,
  openMcpBundle,
  saveMcpBundle,
} from '../../bridge/commands';
import type { McpBundleInfo } from '../../bridge/types';
import { writeClipboard } from '../../viewport';
import css from './SettingsPanel.module.css';

// ── MCP agent setup ────────────────────────────────────────────────────────
//
// Two clients, two mechanisms:
//
//   Claude Desktop — installs the bundled .mcpb, which carries its own copy of
//     the server. Nothing here depends on where LogTapper was installed.
//   Claude Code — launches the `logtapper-mcp` sidecar by absolute path, so the
//     path has to be discoverable. The app is the only thing that reliably
//     knows it, which is why it is surfaced here rather than documented.

/** Claude Desktop reads JSON, so backslashes need escaping — JSON.stringify does it. */
function desktopConfigFor(path: string): string {
  return JSON.stringify({ mcpServers: { logtapper: { command: path } } }, null, 2);
}

function claudeCodeCommandFor(path: string): string {
  return `claude mcp add logtapper --scope user -- "${path}"`;
}

type CopyKey = 'path' | 'code' | 'desktop';

const McpAgentSetup = memo(function McpAgentSetup() {
  const [sidecarPath, setSidecarPath] = useState<string | null>(null);
  const [bundle, setBundle] = useState<McpBundleInfo | null>(null);
  const [resolved, setResolved] = useState(false);
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const [bundleNote, setBundleNote] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([getMcpSidecarPath(), getMcpBundlePath()]).then(([sidecar, b]) => {
      if (cancelled) return;
      if (sidecar.status === 'fulfilled') setSidecarPath(sidecar.value);
      if (b.status === 'fulfilled') setBundle(b.value);
      setResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    if (noteTimer.current) clearTimeout(noteTimer.current);
  }, []);

  const copy = useCallback((key: CopyKey, text: string) => {
    writeClipboard(text);
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  }, []);

  const note = useCallback((message: string) => {
    setBundleNote(message);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setBundleNote(null), 6000);
  }, []);

  const handleInstall = useCallback(() => {
    openMcpBundle()
      .then(() => note('Opened the bundle — confirm the install in Claude Desktop. Nothing happened? Use Save bundle instead.'))
      .catch((e) => note(String(e)));
  }, [note]);

  const handleSave = useCallback(() => {
    saveFileDialog({
      defaultPath: 'logtapper.mcpb',
      filters: [{ name: 'MCP Bundle', extensions: ['mcpb'] }],
    })
      .then((dest) => {
        if (!dest) return;
        return saveMcpBundle(dest).then(() =>
          note(
            `Saved to ${dest} — in Claude Desktop, install it with Developer → Extensions → Install Extension…`,
          ),
        );
      })
      .catch((e) => note(String(e)));
  }, [note]);

  if (!resolved) return null;

  return (
    <div className={css.mcpAgentSetup}>
      <div className={css.mcpAgentSetupTitle}>Connect an AI agent</div>

      {bundle && (
        <div className={css.mcpAgentClient}>
          <div className={css.mcpAgentClientName}>Claude Desktop</div>
          <div className={css.labelHint}>
            {bundle.installable
              ? 'Installs a self-contained extension — no file paths to configure.'
              : 'Save the extension bundle, then install it in Claude Desktop: Developer → Extensions → Install Extension…'}
          </div>
          <div className={css.mcpAgentActions}>
            {bundle.installable && (
              <Button variant="secondary" size="sm" type="button" onClick={handleInstall}>
                Install extension
              </Button>
            )}
            <Button
              variant={bundle.installable ? 'ghost' : 'secondary'}
              size="sm"
              type="button"
              onClick={handleSave}
            >
              Save bundle…
            </Button>
          </div>
          {bundleNote && <div className={css.mcpAgentNote}>{bundleNote}</div>}
        </div>
      )}

      <div className={css.mcpAgentClient}>
        <div className={css.mcpAgentClientName}>Claude Code</div>
        {sidecarPath ? (
          <>
            <div className={css.labelHint}>
              Register the bundled server, then start a new session.
            </div>
            <div className={css.mcpAgentPathRow}>
              <code className={css.mcpAgentPath} title={sidecarPath}>{sidecarPath}</code>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => copy('path', sidecarPath)}
              >
                {copied === 'path' ? 'Copied' : 'Copy path'}
              </Button>
            </div>
            <div className={css.mcpAgentActions}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                title="claude mcp add logtapper --scope user -- <path>"
                onClick={() => copy('code', claudeCodeCommandFor(sidecarPath))}
              >
                {copied === 'code' ? 'Copied' : 'Copy claude mcp add command'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                title="JSON block for claude_desktop_config.json"
                onClick={() => copy('desktop', desktopConfigFor(sidecarPath))}
              >
                {copied === 'desktop' ? 'Copied' : 'Copy JSON config'}
              </Button>
            </div>
          </>
        ) : (
          <div className={css.labelHint}>
            No bundled server binary found — expected in installed builds only. From a
            source checkout, run
            {' '}<code className={css.mcpAgentCode}>node --experimental-strip-types mcp-server/src/index.ts</code>.
            See docs/mcp for the full setup guide.
          </div>
        )}
      </div>
    </div>
  );
});

export default McpAgentSetup;
