// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from 'solid-js';
import { createStreamSession } from './createStreamSession';
import type { AdbStreamEvent } from '@bridge/types';
import type { CacheController } from '@cache/CacheManager';
import type { StreamPusher } from '@viewport/DataSourceRegistry';
import type { ViewLine } from '@bridge/types';

const startAdbStreamMock = vi.fn();
const stopAdbStreamMock = vi.fn();

// `createStreamSession` imports `startAdbStream`/`stopAdbStream` from
// `@bridge/commands` (the only authorized Channel/invoke caller — see
// eslint's no-restricted-imports). Mocking the module is the only way to
// drive its Channel `onEvent` callback without a real Tauri backend.
vi.mock('@bridge/commands', () => ({
  startAdbStream: (...args: unknown[]) => startAdbStreamMock(...args),
  stopAdbStream: (...args: unknown[]) => stopAdbStreamMock(...args),
}));

function makeLoadResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: 's1',
    sourceId: 'adb-emulator-5554',
    sourceName: 'emulator-5554',
    filePath: null,
    totalLines: 0,
    fileSize: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    sourceType: 'Logcat',
    isStreaming: true,
    isIndexing: false,
    hasCrlf: false,
    encoding: 'UTF-8',
    ...overrides,
  };
}

function makeLine(lineNum: number): ViewLine {
  return {
    lineNum,
    raw: `line ${lineNum}`,
    tag: 'Tag',
    message: `line ${lineNum}`,
    level: 'Info',
    timestamp: null,
    highlights: [],
  } as unknown as ViewLine;
}

function makeCacheController(calls: string[]): CacheController {
  return {
    broadcastToSession: vi.fn(() => { calls.push('broadcast'); }),
    clearSession: vi.fn(),
    releaseSessionViews: vi.fn(),
    getSessionEntries: vi.fn(function* () {}),
    setTotalBudget: vi.fn(),
  };
}

function makeRegistry(calls: string[]): StreamPusher {
  return { pushToSession: vi.fn(() => { calls.push('push'); }) };
}

/** Capture the `onEvent` callback `start()` hands to `startAdbStream`. */
function captureOnEvent(): { fire: (e: AdbStreamEvent) => void } {
  let onEvent: ((e: AdbStreamEvent) => void) | undefined;
  startAdbStreamMock.mockImplementation((..._args: unknown[]) => {
    onEvent = _args[4] as (e: AdbStreamEvent) => void;
    return Promise.resolve(makeLoadResult());
  });
  return { fire: (e) => onEvent?.(e) };
}

beforeEach(() => {
  startAdbStreamMock.mockReset();
  stopAdbStreamMock.mockReset();
  stopAdbStreamMock.mockResolvedValue(undefined);
});

function mount() {
  const calls: string[] = [];
  const cacheManager = makeCacheController(calls);
  const registry = makeRegistry(calls);
  return createRoot((dispose) => {
    const session = createStreamSession({ cacheManager, registry });
    return { session, cacheManager, registry, calls, dispose };
  });
}

describe('createStreamSession', () => {
  it('applies a batch: broadcastToSession before pushToSession, in order', async () => {
    const channel = captureOnEvent();
    const { session, cacheManager, registry, calls, dispose } = mount();

    await session.start('emulator-5554');
    expect(session.status()).toMatchObject({ phase: 'streaming', sessionId: 's1' });
    expect(session.active()).toBe(true);

    channel.fire({
      event: 'batch',
      data: {
        sessionId: 's1',
        lines: [makeLine(1), makeLine(2)],
        totalLines: 2,
        byteCount: 100,
        firstTimestamp: null,
        lastTimestamp: null,
        lostLineCount: 0,
      },
    });

    expect(cacheManager.broadcastToSession).toHaveBeenCalledTimes(1);
    expect(registry.pushToSession).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['broadcast', 'push']);
    expect(session.status()).toMatchObject({ phase: 'streaming', totalLines: 2 });

    dispose();
  });

  it('drops late messages that arrive after stop()', async () => {
    const channel = captureOnEvent();
    const { session, cacheManager, registry, dispose } = mount();

    await session.start('emulator-5554');
    await session.stop();
    expect(stopAdbStreamMock).toHaveBeenCalledWith('s1');

    channel.fire({
      event: 'batch',
      data: {
        sessionId: 's1',
        lines: [makeLine(1)],
        totalLines: 1,
        byteCount: 10,
        firstTimestamp: null,
        lastTimestamp: null,
        lostLineCount: 0,
      },
    });

    expect(cacheManager.broadcastToSession).not.toHaveBeenCalled();
    expect(registry.pushToSession).not.toHaveBeenCalled();

    dispose();
  });

  it('drops a message that arrives after the owning root is disposed', async () => {
    const channel = captureOnEvent();
    const { session, cacheManager, dispose } = mount();

    await session.start('emulator-5554');
    dispose();

    channel.fire({
      event: 'batch',
      data: {
        sessionId: 's1',
        lines: [makeLine(1)],
        totalLines: 1,
        byteCount: 10,
        firstTimestamp: null,
        lastTimestamp: null,
        lostLineCount: 0,
      },
    });

    expect(cacheManager.broadcastToSession).not.toHaveBeenCalled();
  });

  it('flips active() false on a streamStopped event', async () => {
    const channel = captureOnEvent();
    const { session, dispose } = mount();

    await session.start('emulator-5554');
    expect(session.active()).toBe(true);

    channel.fire({ event: 'streamStopped', data: { sessionId: 's1', reason: 'eof' } });

    expect(session.active()).toBe(false);
    expect(session.status()).toEqual({ phase: 'stopped', sessionId: 's1', reason: 'eof' });

    dispose();
  });

  it('surfaces a start() failure as an error status without throwing', async () => {
    startAdbStreamMock.mockRejectedValue(new Error('no devices'));
    const { session, dispose } = mount();

    await session.start('emulator-5554');

    expect(session.status()).toMatchObject({ phase: 'error' });
    expect(session.active()).toBe(false);

    dispose();
  });

  describe('incremental filter-AST matching', () => {
    // A `level:E` field node, built by hand rather than through the real
    // parser — this suite only needs to prove the wiring (which lines got
    // checked, and what was reported), not filter-expression syntax.
    const levelEAst: import('@filter/index').FilterNode = { kind: 'field', field: 'level', value: 'E' };

    function mountWithFilter(overrides: {
      filterAst?: () => import('@filter/index').FilterNode | null;
      filterSessionId?: () => string | null;
      packagePids?: () => Map<string, number[]>;
      appendFilterMatches?: (sessionId: string, lineNums: number[]) => void;
    }) {
      const calls: string[] = [];
      const cacheManager = makeCacheController(calls);
      const registry = makeRegistry(calls);
      const appendFilterMatches = overrides.appendFilterMatches ?? vi.fn();
      return createRoot((dispose) => {
        const session = createStreamSession({
          cacheManager,
          registry,
          filterAst: overrides.filterAst ?? (() => levelEAst),
          filterSessionId: overrides.filterSessionId ?? (() => 's1'),
          packagePids: overrides.packagePids,
          appendFilterMatches,
        });
        return { session, appendFilterMatches, dispose };
      });
    }

    function errorLine(lineNum: number): ViewLine {
      return { ...makeLine(lineNum), level: 'Error' } as unknown as ViewLine;
    }

    it('reports matching lines from a batch belonging to the filtered session', async () => {
      const channel = captureOnEvent();
      const { session, appendFilterMatches, dispose } = mountWithFilter({});

      await session.start('emulator-5554');
      channel.fire({
        event: 'batch',
        data: {
          sessionId: 's1',
          lines: [errorLine(1), makeLine(2), errorLine(3)],
          totalLines: 3,
          byteCount: 100,
          firstTimestamp: null,
          lastTimestamp: null,
          lostLineCount: 0,
        },
      });

      expect(appendFilterMatches).toHaveBeenCalledTimes(1);
      expect(appendFilterMatches).toHaveBeenCalledWith('s1', [1, 3]);

      dispose();
    });

    it('does nothing when no line in the batch matches', async () => {
      const channel = captureOnEvent();
      const { session, appendFilterMatches, dispose } = mountWithFilter({});

      await session.start('emulator-5554');
      channel.fire({
        event: 'batch',
        data: {
          sessionId: 's1',
          lines: [makeLine(1), makeLine(2)],
          totalLines: 2,
          byteCount: 100,
          firstTimestamp: null,
          lastTimestamp: null,
          lostLineCount: 0,
        },
      });

      expect(appendFilterMatches).not.toHaveBeenCalled();
      dispose();
    });

    it('never checks lines when the AST is null', async () => {
      const channel = captureOnEvent();
      const { session, appendFilterMatches, dispose } = mountWithFilter({ filterAst: () => null });

      await session.start('emulator-5554');
      channel.fire({
        event: 'batch',
        data: {
          sessionId: 's1',
          lines: [errorLine(1)],
          totalLines: 1,
          byteCount: 10,
          firstTimestamp: null,
          lastTimestamp: null,
          lostLineCount: 0,
        },
      });

      expect(appendFilterMatches).not.toHaveBeenCalled();
      dispose();
    });

    it('never checks lines when the filter targets a different session', async () => {
      const channel = captureOnEvent();
      const { session, appendFilterMatches, dispose } = mountWithFilter({
        filterSessionId: () => 'some-other-session',
      });

      await session.start('emulator-5554');
      channel.fire({
        event: 'batch',
        data: {
          sessionId: 's1',
          lines: [errorLine(1)],
          totalLines: 1,
          byteCount: 10,
          firstTimestamp: null,
          lastTimestamp: null,
          lostLineCount: 0,
        },
      });

      expect(appendFilterMatches).not.toHaveBeenCalled();
      dispose();
    });
  });
});
