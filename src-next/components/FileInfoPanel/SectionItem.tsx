import React, { memo, useCallback, useEffect, useRef } from 'react';
import clsx from 'clsx';
import type { SectionEntry } from './sectionTree';
import { getSectionDescription } from './sectionDescriptions';
import styles from './SectionItem.module.css';
import listStyles from './SectionList.module.css';

export interface SectionItemProps {
  section: SectionEntry;
  isActive: boolean;
  jumpSeq: number;
  startLine: number;
  onJump: ((line: number) => void) | undefined;
  isChild?: boolean;
  originalIndex: number;
  isSelected?: boolean;
  onToggle?: (index: number) => void;
}

const SectionItem = memo<SectionItemProps>(function SectionItem({
  section,
  isActive,
  jumpSeq,
  startLine,
  onJump,
  isChild = false,
  originalIndex,
  isSelected,
  onToggle,
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const handleClick = useCallback(() => onJump?.(startLine), [onJump, startLine]);
  const handleCheckboxChange = useCallback(() => onToggle?.(originalIndex), [onToggle, originalIndex]);
  const stopProp = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  useEffect(() => {
    if (!isActive || !btnRef.current) return;
    const el = btnRef.current;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.style.animation = 'none';
    void el.offsetHeight;
    el.style.animation = '';
  }, [isActive, jumpSeq]);

  const lineCount = section.endLine - section.startLine + 1;
  const description = getSectionDescription(section.name);
  const tooltip = description
    ? `${description}\nLines ${section.startLine + 1}\u2013${section.endLine + 1} (${lineCount.toLocaleString()} lines)`
    : `Lines ${section.startLine + 1}\u2013${section.endLine + 1} (${lineCount.toLocaleString()} lines)`;

  return (
    <button
      ref={btnRef}
      className={clsx(
        styles.sectionItem,
        listStyles.sectionRow,
        isActive && styles.sectionItemActive,
        isChild && listStyles.sectionItemChild,
        isSelected && styles.sectionItemSelected,
      )}
      onClick={handleClick}
      title={tooltip}
    >
      {onToggle && (
        <input
          type="checkbox"
          className={listStyles.sectionCheckbox}
          checked={isSelected ?? false}
          onChange={handleCheckboxChange}
          onClick={stopProp}
        />
      )}
      <span className={styles.sectionName}>{section.name}</span>
      <span className={listStyles.sectionLine}>{lineCount.toLocaleString()}</span>
    </button>
  );
});

export default SectionItem;
