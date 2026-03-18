import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionForPane, useScrollTarget, useViewerActions, useIndexingProgress } from '../../context';
import type { IndexingProgress } from '../../context';
import { getDumpstateMetadata, getSections, getSessionMetadata } from '../../bridge/commands';
import { isBugreportLike } from '../../bridge/types';
import type { DumpstateMetadata } from '../../bridge/types';
import type { AppEvents } from '../../events/events';
import { bus } from '../../events';
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

/** Cached metadata for a session so tab switches restore data instantly. */
interface SessionCache {
  dumpstateMetadata: DumpstateMetadata | null;
  sections: SectionEntry[];
  firstTimestamp: number | null | undefined;
  lastTimestamp: number | null | undefined;
}

// Module-level cache — survives component re-mounts (tab switch away and back).
const metadataCache = new Map<string, SessionCache>();

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

  // Restore from cache on session switch, or start fresh.
  const cached = sessionId ? metadataCache.get(sessionId) : undefined;

  const [totalLines, setTotalLines] = useState<number | undefined>(undefined);
  const [fileSize, setFileSize] = useState<number | undefined>(undefined);
  const [firstTimestamp, setFirstTimestamp] = useState<number | null | undefined>(cached?.firstTimestamp);
  const [lastTimestamp, setLastTimestamp] = useState<number | null | undefined>(cached?.lastTimestamp);
  const [sections, setSections] = useState<SectionEntry[]>(cached?.sections ?? []);
  const [dumpstateMetadata, setDumpstateMetadata] = useState<DumpstateMetadata | null>(cached?.dumpstateMetadata ?? null);
  const [sectionJumpSeq, setSectionJumpSeq] = useState(0);

  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  // Persist to cache whenever fetched data changes.
  useEffect(() => {
    if (!sessionId) return;
    metadataCache.set(sessionId, {
      dumpstateMetadata,
      sections,
      firstTimestamp,
      lastTimestamp,
    });
  }, [sessionId, dumpstateMetadata, sections, firstTimestamp, lastTimestamp]);

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

    // Restore from cache if available, otherwise reset and fetch.
    const c = metadataCache.get(sessionId);

    setTotalLines(session.totalLines);
    setFileSize(session.fileSize);
    setFirstTimestamp(c?.firstTimestamp ?? session.firstTimestamp ?? null);
    setLastTimestamp(c?.lastTimestamp ?? session.lastTimestamp ?? null);
    setSections(c?.sections ?? []);
    setDumpstateMetadata(c?.dumpstateMetadata ?? null);

    // Always fetch fresh metadata (updates cache on completion).
    let cancelled = false;
    getDumpstateMetadata(sessionId)
      .then((meta) => { if (!cancelled) setDumpstateMetadata(meta); })
      .catch(() => { if (!cancelled && !c?.dumpstateMetadata) setDumpstateMetadata(null); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Fetch sections from backend — Bugreport and Dumpstate files only.
  //
  // Gated on `indexingProgress === null` — the backend only populates sections after full
  // indexing completes, so there is no point calling earlier.
  useEffect(() => {
    if (!sessionId || !session || !isBugreportLike(session.sourceType)) return;
    if (indexingProgress !== null) return;  // Still indexing — wait for null

    // Skip fetch if cache already has sections for this session.
    const c = metadataCache.get(sessionId);
    if (c && c.sections.length > 0) {
      setSections(c.sections);
      return;
    }

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

    // Skip if cache already has timestamps.
    const c = metadataCache.get(sessionId);
    if (c?.firstTimestamp != null && c?.lastTimestamp != null) {
      setFirstTimestamp(c.firstTimestamp);
      setLastTimestamp(c.lastTimestamp);
      return;
    }

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

  // Track user line selection via event bus — drives section highlighting
  // when the user clicks lines in the log viewer (not just programmatic jumps).
  // Cleared when a programmatic jump fires so jumpToLine always wins.
  const [selectedLine, setSelectedLine] = useState<number | null>(null);

  useEffect(() => {
    const handler = (ev: AppEvents['selection:changed']) => {
      if (ev.paneId !== paneId) return;
      setSelectedLine(ev.anchor);
    };
    bus.on('selection:changed', handler);
    return () => { bus.off('selection:changed', handler); };
  }, [paneId]);

  // Clear selectedLine when a programmatic jump fires (search, section click)
  // so that effectiveScrollToLine takes over for section tracking.
  useEffect(() => {
    if (effectiveScrollToLine != null) {
      setSelectedLine(null);
    }
  }, [effectiveScrollToLine]);

  const trackingLine = selectedLine ?? effectiveScrollToLine;

  // Reverse iteration prefers the most specific (child) section when ranges overlap.
  // Children come after parents in the array and have narrower ranges, so the last
  // match is always the most specific.
  const activeSectionIndex = useMemo(() => {
    if (trackingLine == null) return -1;
    for (let i = sections.length - 1; i >= 0; i--) {
      const s = sections[i];
      if (trackingLine >= s.startLine && trackingLine <= s.endLine) return i;
    }
    return -1;
  }, [sections, trackingLine]);

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
