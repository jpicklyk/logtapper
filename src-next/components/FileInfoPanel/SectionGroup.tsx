import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import type { SectionEntry } from './sectionTree';
import SectionItem from './SectionItem';
import styles from './SectionGroup.module.css';
import listStyles from './SectionList.module.css';

const EXPAND_PAGE_SIZE = 50;

export interface SectionGroupProps {
  prefix: string;
  sections: { section: SectionEntry; index: number }[];
  totalLines: number;
  activeStartLine: number;
  jumpSeq: number;
  onJump: ((line: number) => void) | undefined;
  selectedSectionIndices?: Set<number>;
  onToggleSection?: (index: number) => void;
  onToggleGroup?: (indices: number[]) => void;
  startLineToOrigIdx: Map<number, number>;
}

const SectionGroup = memo<SectionGroupProps>(function SectionGroup({
  prefix,
  sections,
  totalLines,
  activeStartLine,
  jumpSeq,
  onJump,
  selectedSectionIndices,
  onToggleSection,
  onToggleGroup,
  startLineToOrigIdx,
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(EXPAND_PAGE_SIZE);

  // Check if any section in this group is the active one
  const hasActive = sections.some((item) => item.section.startLine === activeStartLine);

  // Compute group original indices for tri-state checkbox
  const groupOrigIndices = useMemo(
    () => sections.map(item => startLineToOrigIdx.get(item.section.startLine) ?? -1).filter(i => i >= 0),
    [sections, startLineToOrigIdx],
  );
  const allChecked = onToggleGroup != null && groupOrigIndices.length > 0
    && groupOrigIndices.every(i => selectedSectionIndices?.has(i));
  const someChecked = !allChecked && groupOrigIndices.some(i => selectedSectionIndices?.has(i));

  const groupCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (groupCheckboxRef.current) groupCheckboxRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const handleGroupToggle = useCallback(() => onToggleGroup?.(groupOrigIndices), [onToggleGroup, groupOrigIndices]);
  const stopGroupProp = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  // Auto-expand when the active section is inside this group
  useEffect(() => {
    if (hasActive) setExpanded(true);
  }, [hasActive]);

  const toggle = useCallback(() => {
    setExpanded((v) => !v);
    setVisibleCount(EXPAND_PAGE_SIZE);
  }, []);

  const showMore = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setVisibleCount((v) => v + EXPAND_PAGE_SIZE);
  }, []);

  const visibleItems = expanded
    ? (visibleCount >= sections.length ? sections : sections.slice(0, visibleCount))
    : [];
  const hasMore = expanded && visibleCount < sections.length;

  return (
    <div className={styles.sectionGroup}>
      <button
        className={clsx(styles.sectionGroupHeader, listStyles.sectionRow, hasActive && styles.sectionGroupActive)}
        onClick={toggle}
        type="button"
      >
        {onToggleGroup && (
          <input
            ref={groupCheckboxRef}
            type="checkbox"
            className={listStyles.sectionCheckbox}
            checked={allChecked}
            onChange={handleGroupToggle}
            onClick={stopGroupProp}
          />
        )}
        <span className={styles.sectionGroupAccent} />
        <span className={styles.sectionGroupPrefix}>{prefix.trim()}</span>
        <span className={styles.sectionGroupBadge}>{sections.length}</span>
        <span className={listStyles.sectionLine}>{totalLines.toLocaleString()}</span>
        <ChevronRight
          size={12}
          className={clsx(styles.sectionGroupChevron, expanded && styles.sectionGroupChevronOpen)}
        />
      </button>
      {expanded && (
        <div className={styles.sectionGroupItems}>
          {visibleItems.map((item) => {
            const origIdx = startLineToOrigIdx.get(item.section.startLine) ?? -1;
            return (
              <SectionItem
                key={item.section.startLine}
                section={item.section}
                isActive={item.section.startLine === activeStartLine}
                jumpSeq={jumpSeq}
                startLine={item.section.startLine}
                onJump={onJump}
                isChild={false}
                originalIndex={origIdx}
                isSelected={origIdx >= 0 ? selectedSectionIndices?.has(origIdx) : false}
                onToggle={onToggleSection}
              />
            );
          })}
          {hasMore && (
            <button
              className={listStyles.showMoreBtn}
              onClick={showMore}
              type="button"
            >
              Show more ({sections.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export default SectionGroup;
