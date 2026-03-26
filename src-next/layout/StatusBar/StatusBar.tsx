import React, { useCallback, useEffect, useState } from 'react';
import { useSessionForPane, useIsStreamingForPane, useViewerActions } from '../../context';
import { useStatusBarSelection } from '../../hooks';
import { bus } from '../../events';
import type { AppEvents } from '../../events/events';
import { McpStatusPill } from './McpStatusPill';
import styles from './StatusBar.module.css';

interface StatusBarProps {
  activeLogPaneId: string | null;
}

// ── Source type -> chip mapping ──────────────────────────────────────────────

const SOURCE_TYPE_CHIP: Record<string, { label: string; cls: string }> = {
  Logcat:    { label: 'Logcat',    cls: styles.chipLogcat    },
  Bugreport: { label: 'Bugreport', cls: styles.chipBugreport },
  Dumpstate: { label: 'Dumpstate', cls: styles.chipBugreport },
  Kernel:    { label: 'Kernel',    cls: styles.chipKernel    },
};

// ── Pre-computed class strings (static — never change at runtime) ────────────

const CLS_CHIP_PATH   = [styles.chip, styles.chipGray, styles.chipPath].join(' ');
const CLS_CHIP_GRAY   = [styles.chip, styles.chipGray].join(' ');
const CLS_CHIP_LN     = [styles.chip, styles.chipSelection, styles.chipClickable].join(' ');
const CLS_CHIP_SEC    = [styles.chip, styles.chipJumpTarget, styles.chipClickable].join(' ');
const CLS_CHIP_SEL    = [styles.chip, styles.chipSelection, styles.chipDimmed].join(' ');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format 0-based line index as 1-based display number with locale separators. */
const fmtLn = (n: number) => (n + 1).toLocaleString();

/** En-dash for ranges. */
const EN_DASH = '\u2013';

interface ActiveSection {
  sectionName: string | null;
  lineNumber: number | null;
}

const EMPTY_SECTION: ActiveSection = { sectionName: null, lineNumber: null };

// ── Component ────────────────────────────────────────────────────────────────

export const StatusBar = React.memo(function StatusBar({ activeLogPaneId }: StatusBarProps) {
  const session = useSessionForPane(activeLogPaneId);
  const isStreaming = useIsStreamingForPane(activeLogPaneId);
  const selection = useStatusBarSelection(activeLogPaneId);
  const { jumpToLine } = useViewerActions();

  const filePath = session?.filePath ?? null;
  const sourceType = session?.sourceType ?? null;
  const sourceChip = sourceType ? SOURCE_TYPE_CHIP[sourceType] : null;
  const lineEndingLabel = session?.hasCrlf ? 'Windows (CRLF)' : 'Unix (LF)';

  // Subscribe to section:active-changed from useFileInfo (reactive, no cache read).
  const [activeSection, setActiveSection] = useState<ActiveSection>(EMPTY_SECTION);

  useEffect(() => {
    setActiveSection(EMPTY_SECTION);
    if (!activeLogPaneId) return;

    const handler = (ev: AppEvents['section:active-changed']) => {
      if (ev.paneId !== activeLogPaneId) return;
      setActiveSection(prev => {
        if (prev.sectionName === ev.sectionName && prev.lineNumber === ev.lineNumber) return prev;
        return { sectionName: ev.sectionName, lineNumber: ev.lineNumber };
      });
    };

    bus.on('section:active-changed', handler);
    return () => { bus.off('section:active-changed', handler); };
  }, [activeLogPaneId]);

  const { sectionName, lineNumber: sectionLine } = activeSection;

  const hasAnchor = selection.anchor != null;
  const hasRange = selection.range != null;
  const rangeCount = hasRange
    ? selection.range![1] - selection.range![0] + 1
    : 0;

  const handleLnClick = useCallback(() => {
    if (selection.anchor != null) {
      jumpToLine(selection.anchor, activeLogPaneId ?? undefined);
    }
  }, [selection.anchor, jumpToLine, activeLogPaneId]);

  const handleSecClick = useCallback(() => {
    if (sectionLine != null) {
      jumpToLine(sectionLine, activeLogPaneId ?? undefined);
    }
  }, [sectionLine, jumpToLine, activeLogPaneId]);

  return (
    <div className={styles.bar}>
      {/* ── Left zone ─────────────────────────────────────────── */}
      <div className={styles.left}>
        {isStreaming && (
          <span className={styles.streaming}>
            <span className={styles.dot} />
            LIVE
          </span>
        )}

        {sourceChip && (
          <span className={[styles.chip, sourceChip.cls].join(' ')}>
            {sourceChip.label}
          </span>
        )}

        {filePath && (
          <span className={CLS_CHIP_PATH} title={filePath}>
            {filePath}
          </span>
        )}
      </div>

      {/* ── Right zone ────────────────────────────────────────── */}
      <div className={styles.right}>
        {sectionName != null && sectionLine != null && (
          <span className={CLS_CHIP_SEC} onClick={handleSecClick}
                title={`Jump to ${sectionName} (line ${fmtLn(sectionLine)})`}>
            Sec {sectionName} ({fmtLn(sectionLine)})
          </span>
        )}

        {hasAnchor && (
          <span className={CLS_CHIP_LN} onClick={handleLnClick}
                title={`Jump to line ${fmtLn(selection.anchor!)}`}>
            Ln {fmtLn(selection.anchor!)}
          </span>
        )}

        {hasRange && (
          <span className={CLS_CHIP_SEL}>
            Sel {fmtLn(selection.range![0])}{EN_DASH}{fmtLn(selection.range![1])} ({fmtLn(rangeCount)})
          </span>
        )}

        {(hasAnchor || sectionName != null) && <span className={styles.separator} />}

        <span className={CLS_CHIP_GRAY} title="Line endings">
          {lineEndingLabel}
        </span>

        <span className={CLS_CHIP_GRAY} title="File encoding">
          UTF-8
        </span>

        <span className={styles.separator} />

        <McpStatusPill />
      </div>
    </div>
  );
});
