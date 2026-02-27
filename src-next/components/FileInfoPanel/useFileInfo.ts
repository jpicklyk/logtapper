import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionForPane, useScrollTarget, useViewerActions, useIndexingProgress } from '../../context';
import type { IndexingProgress } from '../../context';
import { getDumpstateMetadata, getSections, getSessionMetadata } from '../../bridge/commands';
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
  indexingProgress: IndexingProgress | null;
  onJumpToLine: (line: number) => void;
}

export function useFileInfo(paneId: string | null): FileInfoData {
  const session = useSessionForPane(paneId);
  const { jumpToLine } = useViewerActions();
  const { lineNum: scrollToLine, paneId: jumpPaneId } = useScrollTarget();
  // Only track scroll position as active section if the jump targeted this pane (or was global).
  const effectiveScrollToLine = (jumpPaneId === null || jumpPaneId === paneId) ? scrollToLine : null;

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

  // Fetch sections from backend — Bugreport files only.
  //
  // Gated on `indexingProgress === null` — the backend only populates sections after full
  // indexing completes, so there is no point calling earlier.
  useEffect(() => {
    if (!sessionId || !session || session.sourceType !== 'Bugreport') return;
    if (indexingProgress !== null) return;  // Still indexing — wait for null

    let cancelled = false;
    getSections(sessionId)
      .then((secs) => { if (!cancelled) setSections(secs as SectionEntry[]); })
      .catch(() => { /* leave sections empty on error */ });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, session?.sourceType, indexingProgress]);

  // Refresh timestamps after indexing completes. The initial LoadResult is built
  // from the first 1 MB chunk, so for large files first_timestamp/last_timestamp
  // may both resolve to the same line (e.g. bugreports where only the dumpstate
  // header line has a non-zero timestamp in the opening chunk).
  useEffect(() => {
    if (!sessionId || indexingProgress !== null) return;
    let cancelled = false;
    getSessionMetadata(sessionId)
      .then((meta) => {
        if (cancelled) return;
        setFirstTimestamp(meta.firstTimestamp);
        setLastTimestamp(meta.lastTimestamp);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, indexingProgress]);

  // For streaming sessions, keep size/timestamp local state in sync with the
  // session context. SessionContext is updated on every batch by useStreamSession
  // via updateSession — no separate event listener needed now that adb-batch is
  // delivered via Channel<T>, not as a global broadcast event.
  useEffect(() => {
    if (!session?.isStreaming) return;
    setTotalLines(session.totalLines);
    setFileSize(session.fileSize);
    if (session.firstTimestamp != null) {
      setFirstTimestamp((prev) => prev ?? session.firstTimestamp!);
    }
    if (session.lastTimestamp != null) {
      setLastTimestamp(session.lastTimestamp);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.isStreaming, session?.totalLines, session?.fileSize,
      session?.firstTimestamp, session?.lastTimestamp]);

  // Update totalLines whenever session.totalLines changes during or after indexing.
  // indexingProgress is kept in deps so the effect also fires when indexing completes
  // (transitioning from non-null to null) and session.totalLines holds the final count.
  useEffect(() => {
    if (session) {
      setTotalLines(session.totalLines);
    }
  }, [session?.totalLines, indexingProgress]);

  const activeSectionIndex = sections.findIndex(
    (s) => effectiveScrollToLine != null && effectiveScrollToLine >= s.startLine && effectiveScrollToLine <= s.endLine,
  );

  const onJumpToLine = useCallback(
    (line: number) => {
      setSectionJumpSeq((s) => s + 1);
      jumpToLine(line, paneId ?? undefined);
    },
    [jumpToLine, paneId],
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
    indexingProgress,
    onJumpToLine,
  };
}
