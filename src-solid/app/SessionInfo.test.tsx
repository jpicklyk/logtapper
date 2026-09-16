/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { DumpstateMetadata, LoadResult } from '@bridge/types';
import { SessionInfo } from './SessionInfo';
import type { SessionEntry } from './sessions';

afterEach(cleanup);

function load(overrides: Partial<LoadResult> = {}): LoadResult {
  return {
    sessionId: 'sess-1',
    sourceId: 'sess-1',
    sourceName: 'bugreport.log',
    filePath: 'C:/logs/bugreport.log',
    totalLines: 4_321,
    fileSize: 2 * 1024 * 1024,
    firstTimestamp: 1_000_000_000,
    lastTimestamp: 2_000_000_000,
    sourceType: 'Logcat',
    isStreaming: false,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
    ...overrides,
  };
}

function entry(overrides: Partial<LoadResult> = {}, entryOverrides: Partial<SessionEntry> = {}): SessionEntry {
  const l = load(overrides);
  return {
    load: l,
    totalLines: l.totalLines,
    isIndexing: l.isIndexing,
    kind: l.isStreaming ? 'live' : 'file',
    dataSource: {} as SessionEntry['dataSource'],
    ...entryOverrides,
  };
}

function meta(overrides: Partial<DumpstateMetadata> = {}): DumpstateMetadata {
  return {
    buildString: null,
    buildFingerprint: null,
    osVersion: '14',
    buildType: 'user',
    bootloader: null,
    serial: null,
    uptime: null,
    kernelVersion: null,
    sdkVersion: '34',
    deviceModel: 'Pixel 8',
    manufacturer: 'Google',
    ...overrides,
  };
}

describe('SessionInfo', () => {
  it('renders the trigger with the session name and line count, indexing suffix included', () => {
    render(() => (
      <SessionInfo entry={entry({}, { isIndexing: true })} metadata={null} onReopenAs={vi.fn()} />
    ));

    const trigger = screen.getByTestId('status-session');
    expect(trigger.textContent).toContain('bugreport.log');
    expect(trigger.textContent).toContain('4,321 lines');
    expect(trigger.textContent).toContain('indexing');
  });

  it('opens a dialog popover on click, closed by default', () => {
    render(() => <SessionInfo entry={entry()} metadata={null} onReopenAs={vi.fn()} />);

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('status-session'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows file stats: source type, lines, size, encoding and line endings', () => {
    render(() => (
      <SessionInfo
        entry={entry({ sourceType: 'Kernel', fileSize: 1536, encoding: 'UTF-16 LE', hasCrlf: true })}
        metadata={null}
        onReopenAs={vi.fn()}
      />
    ));
    fireEvent.click(screen.getByTestId('status-session'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Kernel');
    expect(dialog.textContent).toContain('4,321');
    expect(dialog.textContent).toContain('1.5 KB');
    expect(dialog.textContent).toContain('UTF-16 LE');
    expect(dialog.textContent).toContain('CRLF');
  });

  it('shows device fields for a bugreport-like session using the metadata already fetched by the sections store', () => {
    render(() => (
      <SessionInfo entry={entry({ sourceType: 'Bugreport' })} metadata={meta()} onReopenAs={vi.fn()} />
    ));
    fireEvent.click(screen.getByTestId('status-session'));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Pixel 8');
    expect(dialog.textContent).toContain('Google');
    expect(dialog.textContent).toContain('34');
  });

  it('does not show a device block for a non-bugreport session even if metadata is (stale) present', () => {
    render(() => (
      <SessionInfo entry={entry({ sourceType: 'Logcat' })} metadata={meta()} onReopenAs={vi.fn()} />
    ));
    fireEvent.click(screen.getByTestId('status-session'));

    expect(screen.queryByText('Pixel 8')).toBeNull();
  });

  it('offers "reopen as" for a plain file session', () => {
    render(() => <SessionInfo entry={entry()} metadata={null} onReopenAs={vi.fn()} />);
    fireEvent.click(screen.getByTestId('status-session'));

    expect(screen.getByLabelText(/reopen this file as/i)).toBeTruthy();
  });

  it('hides "reopen as" for a live streaming session', () => {
    render(() => (
      <SessionInfo entry={entry({ isStreaming: true }, { kind: 'live' })} metadata={null} onReopenAs={vi.fn()} />
    ));
    fireEvent.click(screen.getByTestId('status-session'));

    expect(screen.queryByLabelText(/reopen this file as/i)).toBeNull();
  });

  it('hides "reopen as" for a .lts bundle path', () => {
    render(() => (
      <SessionInfo entry={entry({ filePath: 'C:/logs/bundle.lts' })} metadata={null} onReopenAs={vi.fn()} />
    ));
    fireEvent.click(screen.getByTestId('status-session'));

    expect(screen.queryByLabelText(/reopen this file as/i)).toBeNull();
  });

  it('hides "reopen as" when the session has no backing file', () => {
    render(() => (
      <SessionInfo entry={entry({ filePath: null })} metadata={null} onReopenAs={vi.fn()} />
    ));
    fireEvent.click(screen.getByTestId('status-session'));

    expect(screen.queryByLabelText(/reopen this file as/i)).toBeNull();
  });

  it('reopening as a different type calls onReopenAs and closes the popover', () => {
    const onReopenAs = vi.fn();
    render(() => <SessionInfo entry={entry({ sourceType: 'Logcat' })} metadata={null} onReopenAs={onReopenAs} />);
    fireEvent.click(screen.getByTestId('status-session'));

    fireEvent.change(screen.getByLabelText(/reopen this file as/i), { target: { value: 'Kernel' } });

    expect(onReopenAs).toHaveBeenCalledWith('Kernel');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('selecting the already-current type is a no-op', () => {
    const onReopenAs = vi.fn();
    render(() => <SessionInfo entry={entry({ sourceType: 'Logcat' })} metadata={null} onReopenAs={onReopenAs} />);
    fireEvent.click(screen.getByTestId('status-session'));

    fireEvent.change(screen.getByLabelText(/reopen this file as/i), { target: { value: 'Logcat' } });

    expect(onReopenAs).not.toHaveBeenCalled();
  });

  it('Escape closes the popover and returns focus to the trigger', () => {
    render(() => <SessionInfo entry={entry()} metadata={null} onReopenAs={vi.fn()} />);
    const trigger = screen.getByTestId('status-session');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a click outside the popover and the trigger closes it', () => {
    render(() => (
      <div>
        <div data-testid="outside">elsewhere</div>
        <SessionInfo entry={entry()} metadata={null} onReopenAs={vi.fn()} />
      </div>
    ));
    fireEvent.click(screen.getByTestId('status-session'));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.pointerDown(screen.getByTestId('outside'));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves focus into the popover on open', () => {
    render(() => <SessionInfo entry={entry()} metadata={null} onReopenAs={vi.fn()} />);
    fireEvent.click(screen.getByTestId('status-session'));

    expect(document.activeElement).toBe(screen.getByTestId('session-info-popover'));
  });
});
