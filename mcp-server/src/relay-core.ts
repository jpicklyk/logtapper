/**
 * Pure helpers for the relay, kept apart from `relay.ts` (which connects
 * stdio at import time) so they can be unit-tested.
 */

/** Where the app serves MCP by default; the backend's `MCP_HTTP_PORT` and the bundle manifest agree. */
export const DEFAULT_UPSTREAM_URL = "http://127.0.0.1:40405/mcp";

/**
 * Pick the upstream URL from the environment (Claude Desktop passes the
 * bundle's "LogTapper MCP URL" setting as `LOGTAPPER_MCP_URL`). Blank or
 * unparsable values fall back to the default rather than wedging the relay —
 * `warn` is told, since a typo there is otherwise invisible.
 */
export function resolveUpstreamUrl(raw: string | undefined, warn: (message: string) => void = () => {}): string {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_UPSTREAM_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported protocol ${url.protocol}`);
    return url.toString();
  } catch (e) {
    warn(`ignoring LOGTAPPER_MCP_URL ${JSON.stringify(raw)} (${(e as Error).message}); using ${DEFAULT_UPSTREAM_URL}`);
    return DEFAULT_UPSTREAM_URL;
  }
}
