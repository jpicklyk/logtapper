import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusedSession, useScrollTarget, useViewerActions, useIndexingProgress } from '../../context';
import { getDumpstateMetadata, getSections } from '../../bridge/commands';
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

  // Update totalLines whenever session.totalLines changes during or after indexing.
  // indexingProgress is kept in deps so the effect also fires when indexing completes
  // (transitioning from non-null to null) and session.totalLines holds the final count.
  useEffect(() => {
    if (session) {
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
