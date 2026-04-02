import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import socialBannerDark from '../../assets/social-banner.png';
import socialBannerLight from '../../assets/social-banner-light.png';
import { useTheme } from '../../context/ThemeContext';
import { Spinner } from '../../ui';
import { LogViewer } from '../LogViewer';
import { ProcessorDashboard } from '../ProcessorDashboard';
import { AnalysisReader } from '../AnalysisReader';
import { EditorTab } from '../EditorTab';
import { StreamFilterBar } from '../StreamFilterBar';
import { BookmarkCreateDialog } from '../BookmarkPanel';
import type { BookmarkCreateRequest } from '../BookmarkPanel';
import { useSessionForPane, useIsLoadingForPane, useViewerActions, useStreamFilter, useFocusedSession, useIsActivePane } from '../../context';
import type { CenterPane } from '../../hooks';
import { useLogViewerActions } from './useLogViewerActions';
import { bus } from '../../events';
import styles from './PaneContent.module.css';

interface Props {
  pane: CenterPane;
  onDirtyChanged?: (tabId: string, isDirty: boolean) => void;
  onFilePathChanged?: (tabId: string, newLabel: string) => void;
}

/** Sorted merge intersection of two sorted number arrays. O(n+m). */
function intersectSorted(a: number[], b: number[]): number[] {
  const result: number[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push(a[i]);
      i++; j++;
    } else if (a[i] < b[j]) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

function EmptyDropZone() {
  const { resolvedTheme } = useTheme();
  const banner = resolvedTheme === 'light' ? socialBannerLight : socialBannerDark;
  return (
    <div className={styles.dropZone}>
      <img src={banner} alt="LogTapper — Android log analysis, reimagined" className={styles.dropZoneBanner} />
    </div>
  );
}

/** Must match the CSS animation duration for noticeSlideOut. */
const NOTICE_EXIT_MS = 400;
const NOTICE_VISIBLE_MS = 4000;

const PaneContent = React.memo(function PaneContent({ pane, onDirtyChanged, onFilePathChanged }: Props) {
  // Use the pane's own session, not the global focused session.
  const session = useSessionForPane(pane.id);
  const focusedSession = useFocusedSession();
  const isActivePane = useIsActivePane(pane.id);
  const isLoading = useIsLoadingForPane(pane.id);
  const { setActiveLogPane, setActivePane, setStreamFilter, cancelStreamFilter, setEffectiveLineNums } = useViewerActions();
  const { fetchLines } = useLogViewerActions(pane.id);
  const { value: filterValue, scanning: filterScanning, filteredLineNums, parseError: filterParseError, sectionFilteredLineNums } = useStreamFilter(pane.id);

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
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const [noticePhase, setNoticePhase] = useState<'entering' | 'exiting' | null>(null);
  const noticeDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeExitRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = ({ paneId, message }: { paneId: string; message: string }) => {
      if (paneId !== pane.id) return;
      // Clear any pending timers from a previous notice.
      if (noticeDismissRef.current) clearTimeout(noticeDismissRef.current);
      if (noticeExitRef.current) clearTimeout(noticeExitRef.current);
      setNoticeText(message);
      setNoticePhase('entering');
      // After the visible duration, start the exit animation.
      noticeDismissRef.current = setTimeout(() => {
        setNoticePhase('exiting');
        // After the exit animation completes, unmount.
        noticeExitRef.current = setTimeout(() => {
          setNoticeText(null);
          setNoticePhase(null);
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

  const effectiveLineNums = useMemo(() => {
    if (!filteredLineNums && !sectionFilteredLineNums) return null;
    if (!filteredLineNums) return sectionFilteredLineNums;
    if (!sectionFilteredLineNums) return filteredLineNums;
    return intersectSorted(sectionFilteredLineNums, filteredLineNums);
  }, [filteredLineNums, sectionFilteredLineNums]);

  // Sync effectiveLineNums into the shared ref so useSearchNavigation can scope
  // search navigation to the currently visible lines. This is a synchronous write
  // during render (ref mutation, no state change) — safe per React's ref contract.
  setEffectiveLineNums(effectiveLineNums);

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

  if (!activeTab) {
    return (
      <>
        <div onClick={handleLogPaneFocus} onFocus={handleLogPaneFocus} className="fullHeight">
          <EmptyDropZone />
        </div>
        {bookmarkDialog}
      </>
    );
  }

  switch (activeTab.type) {
    case 'logviewer':
      if (!session && !isLoading) {
        return (
          <>
            <div onClick={handleLogPaneFocus} onFocus={handleLogPaneFocus} className="fullHeight">
              <EmptyDropZone />
            </div>
            {bookmarkDialog}
          </>
        );
      }
      if (!session && isLoading) {
        return (
          <>
            <div className={styles.loadingPane} onClick={handleLogPaneFocus} onFocus={handleLogPaneFocus}>
              <Spinner size={28} />
              <span className={styles.loadingText}>Loading session{'\u2026'}</span>
            </div>
            {bookmarkDialog}
          </>
        );
      }
      return (
        <>
          <div className={styles.logviewerPane} onClick={handleLogPaneFocus} onFocus={handleLogPaneFocus}>
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
            {noticeText && (
              <div className={`${styles.paneNotice} ${noticePhase === 'exiting' ? styles.paneNoticeExit : ''}`}>
                {noticeText}
              </div>
            )}
            <LogViewer
              paneId={pane.id}
              fetchLines={fetchLines}
              lineNumbers={effectiveLineNums ?? undefined}
            />
          </div>
          {bookmarkDialog}
        </>
      );

    case 'dashboard':
      // Dashboard displays results for the focused session — clicking it should
      // NOT move the focus marker away from the logviewer tab that owns the session.
      return focusedSession ? (
        <>
          <div className="fullHeight">
            <ProcessorDashboard />
          </div>
          {bookmarkDialog}
        </>
      ) : (
        <>
          <div className={styles.placeholder}>
            Open a log file to see the dashboard.
          </div>
          {bookmarkDialog}
        </>
      );

    case 'analysis':
      return (
        <>
          <div className="fullHeight">
            <AnalysisReader />
          </div>
          {bookmarkDialog}
        </>
      );

    case 'editor':
      return (
        <>
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div onClick={handleActivePaneFocus} onFocus={handleActivePaneFocus} className="fullHeight">
            <EditorTab
              tabId={activeTab.id}
              tabLabel={activeTab.label}
              isFocused={isActivePane}
              onDirtyChanged={onDirtyChanged}
              onFilePathChanged={onFilePathChanged}
            />
          </div>
          {bookmarkDialog}
        </>
      );

    default:
      return bookmarkDialog;
  }
});

export default PaneContent;
