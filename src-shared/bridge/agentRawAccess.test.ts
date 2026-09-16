/**
 * Agent raw-log access — the one switch that decides whether agents reading
 * over the MCP bridge see PII.
 *
 * These pin the IPC wiring the Settings → General → MCP Integration checkbox
 * depends on: the command names and argument shape the backend registers
 * (`get_agent_raw_access` / `set_agent_raw_access`), and the absence of the
 * old per-session `setMcpAnonymize` writer that the pipeline chain used to
 * drive. A second writer reintroduced anywhere is how the leak this replaced
 * happened in the first place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

import * as commands from './commands';

beforeEach(() => {
  invokeMock.mockReset();
});

describe('getAgentRawAccess', () => {
  it('invokes the registered read command with no arguments', async () => {
    invokeMock.mockResolvedValue(false);
    await expect(commands.getAgentRawAccess()).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('get_agent_raw_access');
  });

  it('passes the backend value through unchanged when the user opted out', async () => {
    invokeMock.mockResolvedValue(true);
    await expect(commands.getAgentRawAccess()).resolves.toBe(true);
  });
});

describe('setAgentRawAccess', () => {
  it('sends the enabled flag under the camelCase key the command expects', async () => {
    invokeMock.mockResolvedValue(undefined);
    await commands.setAgentRawAccess(true);
    expect(invokeMock).toHaveBeenCalledWith('set_agent_raw_access', { enabled: true });
  });

  it('can turn anonymization back on', async () => {
    invokeMock.mockResolvedValue(undefined);
    await commands.setAgentRawAccess(false);
    expect(invokeMock).toHaveBeenCalledWith('set_agent_raw_access', { enabled: false });
  });

  it('does not swallow a backend refusal', async () => {
    invokeMock.mockRejectedValue('agents may not modify agent raw log access');
    await expect(commands.setAgentRawAccess(true)).rejects.toBeTruthy();
  });
});

describe('the removed per-session anonymize writer', () => {
  it('is gone from the bridge surface', () => {
    expect('setMcpAnonymize' in commands).toBe(false);
  });
});
