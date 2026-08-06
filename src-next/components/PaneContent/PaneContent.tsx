import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmptyStatePane } from './EmptyStatePane';
import { LogViewer } from '../LogViewer';
import { ProcessorDashboard } from '../ProcessorDashboard';
import { AnalysisReader } from '../AnalysisReader';
import { EditorTab } from '../EditorTab';
import { StreamFilterBar } from '../StreamFilterBar';
import { SearchBar } from '../SearchBar';
import { BookmarkCreateDialog } from '../BookmarkPanel';
import type { BookmarkCreateRequest } from '../BookmarkPanel';
import { useSessionForPane, useIsLoadingForPane, usePaneActions, useStreamFilter, useFocusedSession, SessionProviders, usePaneSearchActions } from '../../context';
import type { CenterPane } from '../../hooks';
import { useLogViewerActions } from './useLogViewerActions';
import { bus } from '../../events';
import { intersectAllSorted } from '../../utils';
import styles from './PaneContent.module.css';

interface Props {
  pane: CenterPane;
  onDirtyChanged?: (tabId: string, isDirty: boolean) => void;
  onFilePathChanged?: (tabId: string, newLabel: string) => void;
}

/** Must match the CSS animation duration for noticeSlideOut. */
const NOTICE_EXIT_MS = 400;
const NOTICE_VISIBLE_MS = 4000;

const PaneContentInner = React.memo(function PaneContentInner({ pane, onDirtyChanged, onFilePathChanged }: Props) {
  // Use the pane's own session, not the global focused session.
  const session = useSessionForPane(pane.id);
  const focusedSession = useFocusedSession();
  const isLoading = useIsLoadingForPane(pane.id);
  const { setActiveLogPane, setActivePane, setStreamFilter, cancelStreamFilter, setTimeFilter } = usePaneActions();
  const { setEffectiveLineNums } = usePaneSearchActions();
  const { fetchLines } = useLogViewerActions(pane.id);
  const {
    value: filterValue, scanning: filterScanning, filteredLineNums, parseError: filterParseError,
    sectionFilteredLineNums, timeFilterStart, timeFilterEnd, timeFilterLineNums,
  } = useStreamFilter(pane.id);

  // ── Bookmark creation dialog ──────────────────────────────────────────────
  const [bookmarkRequest, setBookmarkRequest] = useState<BookmarkCreateRequest | null>(null);

  // Listen for bookmark:create-request events targeted at this pane.
  // StrictMode-safe: the handler is not async so no cleanup race needed.
  useEffect(() => {
    const handler = (req: BookmarkCreateRequest) => {
      if (req.paneId === pane.id) {
        setBookmarkRequest(req);
      }
    };
    bus.on('bookmark:create-request', handler);
    return () => bus.off('bookmark:create-request', handler);
  }, [pane.id]);

  const handleBookmarkDialogClose = useCallback(() => {
    setBookmarkRequest(null);
  }, []);

  // ── Inline pane notice (auto-dismissing banner with enter/exit animation) ──
  const [notice, setNotice] = useState<{ text: string; phase: 'entering' | 'exiting' } | null>(null);
  const noticeDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeExitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = ({ paneId, message }: { paneId: string; message: string }) => {
      if (paneId !== pane.id) return;
      // Clear any pending timers from a previous notice.
      if (noticeDismissRef.current) clearTimeout(noticeDismissRef.current);
      if (noticeExitRef.current) clearTimeout(noticeExitRef.current);
      setNotice({ text: message, phase: 'entering' });
      // After the visible duration, start the exit animation.
      noticeDismissRef.current = setTimeout(() => {
        setNotice((prev) => prev ? { text: prev.text, phase: 'exiting' } : null);
        // After the exit animation completes, unmount.
        noticeExitRef.current = setTimeout(() => {
          setNotice(null);
        }, NOTICE_EXIT_MS);
      }, NOTICE_VISIBLE_MS);
    };
    bus.on('pane:notice', handler);
    return () => {
      bus.off('pane:notice', handler);
      if (noticeDismissRef.current) clearTimeout(noticeDismissRef.current);
      if (noticeExitRef.current) clearTimeout(noticeExitRef.current);
    };
  }, [pane.id]);

  const effectiveLineNums = useMemo(
    () => intersectAllSorted([sectionFilteredLineNums, filteredLineNums, timeFilterLineNums]),
    [filteredLineNums, sectionFilteredLineNums, timeFilterLineNums],
  );

  // Session this pane's search is scoped to — mirrors the sessionId passed to
  // SessionProviders/PaneSearchProvider by the outer PaneContent below.
  const sessionId = session?.sessionId ?? focusedSession?.sessionId ?? null;

  // Publish this pane's visible lines so its own match navigation can be scoped
  // to them. Each pane writes to its own PaneSearchProvider ref, so two panes no
  // longer race over a single shared ref. This is a committed effect, not a
  // render-phase write — writing to the ref during render is itself a side
  // effect (React may re-invoke render), and PaneSearchContext's own
  // [sessionId] effect relies on this effect having already run (child
  // effects flush before parent effects) to avoid clobbering a stale value.
  // Keyed on sessionId too, not just effectiveLineNums, so a session switch
  // that happens to compute the same (e.g. null) value still republishes —
  // otherwise the ref would keep the previous session's scoped lines.
  useEffect(() => {
    setEffectiveLineNums(effectiveLineNums);
  }, [effectiveLineNums, sessionId, setEffectiveLineNums]);

  const handleLogPaneFocus = useCallback(() => {
    setActiveLogPane(pane.id);
  }, [pane.id, setActiveLogPane]);

  const handleActivePaneFocus = useCallback(() => {
    setActivePane(pane.id);
  }, [pane.id, setActivePane]);

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);

  // Bookmark dialog is rendered as a portal to document.body regardless of
  // which tab is active — it persists as long as this PaneContent is mounted.
  const bookmarkDialog = (
    <BookmarkCreateDialog
      request={bookmarkRequest}
      onClose={handleBookmarkDialogClose}
    />
  );

  const renderContent = () => {
    if (!activeTab) {
      return (
        <div onClick={handleLogPaneFocus} onFocus={handleLogPaneFocus} className="fullHeight">
          <EmptyStatePane />
        </div>
      );
    }

    switch (activeTab.type) {
      case 'logviewer':
        if (!session && !isLoading) {
          return (
            <div onClick={handleLogPaneFocus} onFocus={handleLogPaneFocus} className="fullHeight">
              <EmptyStatePane />
            </div>
          );
        }
        if (!session && isLoading) {
          return (
            <div onClick={handleLogPaneFocus} onFocus={handleLogPaneFocus} className="fullHeight">
              <EmptyStatePane loading />
            </div>
          );
        }
        return (
          <div className={styles.logviewerPane} onClick={handleLogPaneFocus} onFocus={handleLogPaneFocus}>
            {session && (
              <SearchBar
                paneId={pane.id}
                disabled={!session}
                onTimeFilter={setTimeFilter}
                timeStart={timeFilterStart}
                timeEnd={timeFilterEnd}
                timeFilterCount={timeFilterLineNums ? timeFilterLineNums.length : null}
              />
            )}
            {session && (
              <StreamFilterBar
                value={filterValue}
                onCommit={setStreamFilter}
                onCancel={cancelStreamFilter}
                matchCount={filteredLineNums ? (effectiveLineNums?.length ?? null) : null}
                totalLines={sectionFilteredLineNums ? sectionFilteredLineNums.length : session.totalLines}
                parseError={filterParseError}
                scanning={filterScanning}
              />
            )}
            {notice && (
              <div className={`${styles.paneNotice} ${notice.phase === 'exiting' ? styles.paneNoticeExit : ''}`}>
                {notice.text}
              </div>
            )}
            <LogViewer
              paneId={pane.id}
              fetchLines={fetchLines}
              lineNumbers={effectiveLineNums ?? undefined}
            />
          </div>
        );

      case 'dashboard':
        return focusedSession ? (
          <div className="fullHeight">
            <ProcessorDashboard />
          </div>
        ) : (
          <div className={styles.placeholder}>
            Open a log file to see the dashboard.
          </div>
        );

      case 'analysis':
        return (
          <div className="fullHeight">
            <AnalysisReader paneId={pane.id} />
          </div>
        );

      case 'editor':
        return (
          <div onClick={handleActivePaneFocus} onFocus={handleActivePaneFocus} className="fullHeight">
            <EditorTab
              tabId={activeTab.id}
              paneId={pane.id}
              tabLabel={activeTab.label}
              onDirtyChanged={onDirtyChanged}
              onFilePathChanged={onFilePathChanged}
            />
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      {renderContent()}
      {bookmarkDialog}
    </>
  );
});

/**
 * Outer shell: resolves the pane's session and mounts the per-session/per-pane
 * providers. The body lives in PaneContentInner so that everything inside it —
 * including `useLogViewerActions` and the effective-line-nums publish — reads
 * this pane's own search scope rather than a global one.
 */
const PaneContent = React.memo(function PaneContent(props: Props) {
  const session = useSessionForPane(props.pane.id);
  const focusedSession = useFocusedSession();
  // Dashboard tabs fall back to the focused session (they show its results).
  const sessionId = session?.sessionId ?? focusedSession?.sessionId ?? null;

  return (
    <SessionProviders sessionId={sessionId} paneId={props.pane.id}>
      <PaneContentInner {...props} />
    </SessionProviders>
  );
});

export default PaneContent;
