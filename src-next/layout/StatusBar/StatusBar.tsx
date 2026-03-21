import React, { useCallback } from 'react';
import { useSessionForPane, useIsStreamingForPane, useScrollTarget, useViewerActions } from '../../context';
import { useStatusBarSelection } from '../../hooks';
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

const CLS_FILEPATH    = [styles.item, styles.filePath].join(' ');
const CLS_MONO_INT    = [styles.item, styles.mono, styles.interactive].join(' ');
const CLS_CHIP_LN     = [styles.chip, styles.chipSelection, styles.chipClickable].join(' ');
const CLS_CHIP_SEC    = [styles.chip, styles.chipJumpTarget, styles.chipClickable].join(' ');
const CLS_CHIP_SEL    = [styles.chip, styles.chipSelection, styles.chipDimmed].join(' ');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format 0-based line index as 1-based display number with locale separators. */
const fmtLn = (n: number) => (n + 1).toLocaleString();

/** En-dash for ranges. */
const EN_DASH = '\u2013';

// ── Component ────────────────────────────────────────────────────────────────

export const StatusBar = React.memo(function StatusBar({ activeLogPaneId }: StatusBarProps) {
  const session = useSessionForPane(activeLogPaneId);
  const isStreaming = useIsStreamingForPane(activeLogPaneId);
  const selection = useStatusBarSelection(activeLogPaneId);
  const { jumpToLine } = useViewerActions();

  const { lineNum: scrollTarget, paneId: jumpPaneId } = useScrollTarget();

  const filePath = session?.filePath ?? null;
  const sourceType = session?.sourceType ?? null;
  const sourceChip = sourceType ? SOURCE_TYPE_CHIP[sourceType] : null;

  // Scroll target applies when the jump targeted this pane (or was global).
  const effectiveScrollTarget = (jumpPaneId === null || jumpPaneId === activeLogPaneId)
    ? scrollTarget : null;

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
    if (effectiveScrollTarget != null) {
      jumpToLine(effectiveScrollTarget, activeLogPaneId ?? undefined);
    }
  }, [effectiveScrollTarget, jumpToLine, activeLogPaneId]);

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
          <span className={CLS_FILEPATH} title={filePath}>
            {filePath}
          </span>
        )}
      </div>

      {/* ── Right zone ────────────────────────────────────────── */}
      <div className={styles.right}>
        {effectiveScrollTarget != null && (
          <span className={CLS_CHIP_SEC} onClick={handleSecClick}
                title={`Jump to section line ${fmtLn(effectiveScrollTarget)}`}>
            Sec {fmtLn(effectiveScrollTarget)}
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

        {(hasAnchor || effectiveScrollTarget != null) && <span className={styles.separator} />}

        <span className={CLS_MONO_INT} title="Line endings">
          LF
        </span>

        <span className={CLS_MONO_INT} title="File encoding">
          UTF-8
        </span>

        <span className={styles.separator} />

        <McpStatusPill />
      </div>
    </div>
  );
});
