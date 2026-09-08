import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../ui';
import { getMcpSidecarPath } from '../../bridge/commands';
import { writeClipboard } from '../../viewport';
import css from './SettingsPanel.module.css';

// ── MCP agent setup (sidecar path + copyable client config) ───────────────
//
// The bundled `logtapper-mcp` binary sits next to the app executable, so the
// app is the only thing that reliably knows its path. Surfacing it here (and
// pre-building the client config) removes the manual path hunt that connecting
// Claude Code or Claude Desktop would otherwise require.

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
  const [resolved, setResolved] = useState(false);
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMcpSidecarPath()
      .then((path) => {
        if (!cancelled) {
          setSidecarPath(path);
          setResolved(true);
        }
      })
      .catch(() => {
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const copy = useCallback((key: CopyKey, text: string) => {
    writeClipboard(text);
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  }, []);

  if (!resolved) return null;

  if (!sidecarPath) {
    return (
      <div className={css.mcpAgentSetup}>
        <div className={css.mcpAgentSetupTitle}>Connect an AI agent</div>
        <div className={css.labelHint}>
          No bundled MCP binary found — expected in installed builds only. From a
          source checkout, run the server with
          {' '}<code className={css.mcpAgentCode}>node --experimental-strip-types mcp-server/src/index.ts</code>.
          See docs/mcp for the full setup guide.
        </div>
      </div>
    );
  }

  return (
    <div className={css.mcpAgentSetup}>
      <div className={css.mcpAgentSetupTitle}>Connect an AI agent</div>
      <div className={css.labelHint}>
        Your AI client launches this binary to reach LogTapper. Copy a
        ready-to-paste configuration below.
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
          {copied === 'code' ? 'Copied' : 'Copy Claude Code command'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          title="JSON block for claude_desktop_config.json"
          onClick={() => copy('desktop', desktopConfigFor(sidecarPath))}
        >
          {copied === 'desktop' ? 'Copied' : 'Copy Claude Desktop config'}
        </Button>
      </div>
    </div>
  );
});

export default McpAgentSetup;
