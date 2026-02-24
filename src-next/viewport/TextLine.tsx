import { memo, useEffect, useRef } from 'react';
import type { ViewLine } from '../bridge/types';
import type { GutterColumnDef } from './GutterColumn';
import type { LineDecoratorDef } from './LineDecorator';
import { HighlightedText } from '../components/HighlightedText';
import styles from './TextLine.module.css';

interface TextLineProps {
  line: ViewLine;
  lineHeight: number;
  gutterColumns?: GutterColumnDef[];
  decorators?: LineDecoratorDef[];
  isSelected?: boolean;
  isJumpTarget?: boolean;
  jumpSeq?: number;
  onClick?: (lineNum: number, e: React.MouseEvent) => void;
}

const LEVEL_CLASS: Record<string, string> = {
  Verbose: styles.levelV,
  Debug: styles.levelD,
  Info: styles.levelI,
  Warn: styles.levelW,
  Error: styles.levelE,
  Fatal: styles.levelF,
};

const TextLine = memo(function TextLine({
  line,
  lineHeight,
  gutterColumns,
  decorators,
  isSelected,
  isJumpTarget,
  jumpSeq,
  onClick,
}: TextLineProps) {
  const lineRef = useRef<HTMLDivElement>(null);

  // Restart the flash animation on every jump (including repeated jumps to the same line).
  useEffect(() => {
    if (!isJumpTarget || !lineRef.current) return;
    const el = lineRef.current;
    el.style.animation = 'none';
    void el.offsetHeight; // force reflow so the browser resets the animation
    el.style.animation = '';
  }, [isJumpTarget, jumpSeq]);

  const levelClass = LEVEL_CLASS[line.level] ?? '';

  // Compute decorator classes and styles
  let extraClasses = '';
  let extraStyles: React.CSSProperties | undefined;
  if (decorators) {
    const classList: string[] = [];
    for (const dec of decorators) {
      if (dec.classNames) {
        classList.push(...dec.classNames(line, !!isSelected, !!isJumpTarget));
      }
      if (dec.styles) {
        const s = dec.styles(line);
        if (s) {
          extraStyles = extraStyles ? { ...extraStyles, ...s } : s;
        }
      }
    }
    if (classList.length > 0) {
      extraClasses = ' ' + classList.join(' ');
    }
  }

  const className = [
    styles.line,
    levelClass,
    isSelected ? styles.selected : '',
    isJumpTarget ? styles.jumpTarget : '',
  ].filter(Boolean).join(' ') + extraClasses;

  const combinedStyle: React.CSSProperties = { height: lineHeight, ...extraStyles };

  return (
    <div
      ref={lineRef}
      className={className}
      style={combinedStyle}
      onClick={(e) => onClick?.(line.lineNum, e)}
    >
      {gutterColumns?.map((col) => (
        <span
          key={col.id}
          className={styles.gutter}
          style={{ width: col.width }}
        >
          {col.render(line.lineNum)}
        </span>
      ))}
      <span className={styles.msg}>
        <HighlightedText text={line.raw} highlights={line.highlights} />
      </span>
    </div>
  );
});

export default TextLine;

export function TextLineSkeleton({ lineNum, lineHeight }: { lineNum: number; lineHeight: number }) {
  return (
    <div className={`${styles.line} ${styles.skeleton}`} style={{ height: lineHeight }}>
      <span className={styles.lineNum}>
        {String(lineNum + 1).padStart(7, ' ')}
      </span>
      <span className={styles.skeletonBar} />
    </div>
  );
}
