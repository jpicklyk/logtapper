import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusedSession, useScrollTarget, useViewerActions, useIndexingProgress } from '../../context';
import { useViewCache, useDataSourceRegistry } from '../../cache';
import { createCacheDataSource, type CacheDataSource } from '../../viewport';
import { getDumpstateMetadata, getLines } from '../../bridge/commands';
import { onAdbBatch } from '../../bridge/events';
import type { DumpstateMetadata } from '../../bridge/types';
import type { SectionEntry } from './FileInfoPanel';

export interface FileInfoData {
  sourceName: string | undefined;
  sourceType: string | undefined;
  totalLines: number | undefined;
  fileSize: number | undefined;
  firstTimestamp: number | null | undefined;
  lastTimestamp: number | null | undefined;
  sections: SectionEntry[];
  dumpstateMetadata: DumpstateMetadata | null;
  activeSectionIndex: number;
  sectionJumpSeq: number;
  onJumpToLine: (line: number) => void;
}

const SCAN_BATCH = 2_000;

export function useFileInfo(): FileInfoData {
  // Use the focused session, not the global (unchanged) useSession() — this is now the same
  // thing, but explicit about intent.
  const session = useFocusedSession();
  const { jumpToLine } = useViewerActions();
  const { lineNum: scrollToLine } = useScrollTarget();

  const sessionId = session?.sessionId ?? null;

  // Reactive indexing progress — null means indexing is complete (or never started for
  // pre-indexed files). Non-null means indexing is still running. This replaces the
  // onFileIndexComplete Tauri event listener approach that had a startup race condition.
  const indexingProgress = useIndexingProgress(sessionId);

  const [totalLines, setTotalLines] = useState<number | undefined>(undefined);
  const [fileSize, setFileSize] = useState<number | undefined>(undefined);
  const [firstTimestamp, setFirstTimestamp] = useState<number | null | undefined>(undefined);
  const [lastTimestamp, setLastTimestamp] = useState<number | null | undefined>(undefined);
  const [sections, setSections] = useState<SectionEntry[]>([]);
  const [dumpstateMetadata, setDumpstateMetadata] = useState<DumpstateMetadata | null>(null);
  const [sectionJumpSeq, setSectionJumpSeq] = useState(0);

  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  const viewCache = useViewCache(
    sessionId ? `file-info-${sessionId}` : null,
    sessionId,
  );
  const registry = useDataSourceRegistry();

  // Reset base metadata and fetch device info whenever the session changes.
  useEffect(() => {
    if (!sessionId || !session) {
      setTotalLines(undefined);
      setFileSize(undefined);
      setFirstTimestamp(undefined);
      setLastTimestamp(undefined);
      setSections([]);
      setDumpstateMetadata(null);
      return;
    }

    setTotalLines(session.totalLines);
    setFileSize(session.fileSize);
    setFirstTimestamp(session.firstTimestamp ?? null);
    setLastTimestamp(session.lastTimestamp ?? null);
    setSections([]);
    setDumpstateMetadata(null);

    let cancelled = false;
    getDumpstateMetadata(sessionId)
      .then((meta) => { if (!cancelled) setDumpstateMetadata(meta); })
      .catch(() => { if (!cancelled) setDumpstateMetadata(null); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Background section scan — Bugreport files only.
  //
  // Gated on `indexingProgress === null`:
  //   - App restart with pre-indexed file: progress is null on mount → scan starts immediately.
  //   - Fresh large file: progress starts non-null (sentinel set in loadFile); when indexing
  //     completes the sentinel is cleared to null and this effect re-runs with final totalLines.
  //   - Logcat / stream sessions: bail at sourceType check; no work done.
  useEffect(() => {
    if (!viewCache || !sessionId || !session || session.sourceType !== 'Bugreport') return;
    if (indexingProgress !== null) return;  // Still indexing — wait for null

    const fileTotalLines = session.totalLines;
    console.debug('[FileInfoPanel] scan start', { sessionId, fileTotalLines });

    let cancelled = false;
    let ds: CacheDataSource | null = null;

    ds = createCacheDataSource({
      sessionId,
      viewCache,
      fetchLines: (offset, count) =>
        getLines({ sessionId, mode: { mode: 'Full' }, offset, count, context: 0 }),
      registry,
    });

    let offset = 0;
    const pending = new Map<string, number>();
    const found: SectionEntry[] = [];

    const scan = async () => {
      if (cancelled) {
        ds?.dispose();
        ds = null;
        return;
      }
      if (offset >= fileTotalLines) {
        console.debug('[FileInfoPanel] scan complete', {
          totalFound: found.length,
          unpairedHeaders: [...pending.keys()],
        });
        setSections([...found]);
        ds?.dispose();
        ds = null;
        return;
      }

      const count = Math.min(SCAN_BATCH, fileTotalLines - offset);
      const lines = await ds!.getLines(offset, count);

      console.debug('[FileInfoPanel] batch', {
        offset,
        linesInBatch: lines.length,
        sectionBoundariesFound: found.length,
      });

      for (const line of lines) {
        if (!line.raw.startsWith('------')) continue;
        if (line.level === 'Info' && line.tag) {
          pending.set(line.tag, line.lineNum);
        } else if (line.level === 'Verbose' && line.tag) {
          const startLine = pending.get(line.tag);
          if (startLine !== undefined) {
            found.push({ name: line.tag, startLine, endLine: line.lineNum });
            pending.delete(line.tag);
          }
        }
      }

      offset += count;
      setTimeout(scan, 0);
    };

    scan();

    return () => {
      cancelled = true;
      ds?.dispose();
      ds = null;
    };
    // indexingProgress is the reactive gate — when it becomes null the scan starts.
    // session?.sourceType and fileTotalLines come from session which depends on sessionId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.sourceType, indexingProgress, viewCache, registry]);

  // Subscribe to ADB batch events for real-time size/timestamp updates.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    onAdbBatch((payload) => {
      if (cancelled || payload.sessionId !== sessionIdRef.current) return;
      setTotalLines(payload.totalLines);
      setFileSize(payload.byteCount);
      if (payload.firstTimestamp != null) {
        setFirstTimestamp((prev) => prev ?? payload.firstTimestamp);
      }
      if (payload.lastTimestamp != null) {
        setLastTimestamp(payload.lastTimestamp);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Update totalLines when indexing progresses (so the panel shows live line count)
  useEffect(() => {
    if (session && indexingProgress) {
      setTotalLines(session.totalLines);
    }
  }, [session?.totalLines, indexingProgress]);

  const activeSectionIndex = sections.findIndex(
    (s) => scrollToLine != null && scrollToLine >= s.startLine && scrollToLine <= s.endLine,
  );

  const onJumpToLine = useCallback(
    (line: number) => {
      setSectionJumpSeq((s) => s + 1);
      jumpToLine(line);
    },
    [jumpToLine],
  );

  return {
    sourceName: session?.sourceName,
    sourceType: session?.sourceType,
    totalLines,
    fileSize,
    firstTimestamp,
    lastTimestamp,
    sections,
    dumpstateMetadata,
    activeSectionIndex,
    sectionJumpSeq,
    onJumpToLine,
  };
}
