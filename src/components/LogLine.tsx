import { memo, useEffect, useRef } from 'react';
import type { ViewLine } from '../bridge/types';
import HighlightedText from './HighlightedText';

interface Props {
  line: ViewLine;
  style: React.CSSProperties;
  onClick?: (lineNum: number, e: React.MouseEvent) => void;
  /** True when this line is the active jump target (section click, match jump). */
  isJumpTarget?: boolean;
  /** Incremented each time the same line is jumped to; triggers animation restart. */
  jumpSeq?: number;
  /** True when one or more StateTrackers transitioned on this line. */
  hasTransition?: boolean;
  /** Names of trackers that transitioned on this line (for tooltip). */
  transitionTrackers?: string[];
  /** True when this line is part of the active multi-line selection. */
  isSelected?: boolean;
}

const LEVEL_CLASS: Record<string, string> = {
  Verbose: 'level-v',
  Debug: 'level-d',
  Info: 'level-i',
  Warn: 'level-w',
  Error: 'level-e',
  Fatal: 'level-f',
};

const LogLine = memo(function LogLine({ line, style, onClick, isJumpTarget, jumpSeq, hasTransition, transitionTrackers, isSelected }: Props) {
  const levelClass = LEVEL_CLASS[line.level] ?? '';
  const lineRef = useRef<HTMLDivElement>(null);

  // Restart the flash animation on every jump (including repeated jumps to the same line).
  useEffect(() => {
    if (!isJumpTarget || !lineRef.current) return;
    const el = lineRef.current;
    el.style.animation = 'none';
    void el.offsetHeight; // force reflow so the browser resets the animation
    el.style.animation = '';
  }, [isJumpTarget, jumpSeq]);

  const tooltip = transitionTrackers?.length
    ? `State change: ${transitionTrackers.join(', ')}`
    : undefined;

  return (
    <div
      ref={lineRef}
      className={`log-line ${levelClass} ${line.isContext ? 'context-line' : ''}${isJumpTarget ? ' log-line--jump-target' : ''}${isSelected ? ' log-line--selected' : ''}`}
      style={style}
      onClick={(e) => onClick?.(line.lineNum, e)}
    >
      <span className="log-gutter" title={tooltip}>
        {hasTransition && <span className="log-gutter-dot">◆</span>}
      </span>
      <span className="log-linenum">{line.lineNum + 1}</span>
      <span className="log-msg">
        <HighlightedText text={line.raw} highlights={line.highlights} />
      </span>
    </div>
  );
});

export default LogLine;
