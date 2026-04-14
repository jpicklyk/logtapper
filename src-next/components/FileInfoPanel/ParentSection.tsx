import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import type { SectionEntry } from './sectionTree';
import SectionItem from './SectionItem';
import styles from './ParentSection.module.css';
import listStyles from './SectionList.module.css';

const EXPAND_PAGE_SIZE = 50;

export interface ParentSectionProps {
  section: SectionEntry;
  children: { section: SectionEntry; index: number }[];
  totalLines: number;
  activeStartLine: number;
  jumpSeq: number;
  onJump: ((line: number) => void) | undefined;
  selectedSectionIndices?: Set<number>;
  onToggleSection?: (index: number) => void;
  onToggleGroup?: (indices: number[]) => void;
  startLineToOrigIdx: Map<number, number>;
}

const ParentSection = memo<ParentSectionProps>(function ParentSection({
  section,
  children,
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

  const isParentActive = section.startLine === activeStartLine;
  const hasActiveChild = children.some(c => c.section.startLine === activeStartLine);

  // Compute group original indices for tri-state checkbox
  const parentOrigIdx = startLineToOrigIdx.get(section.startLine) ?? -1;
  const childOrigIndices = useMemo(
    () => children.map(c => startLineToOrigIdx.get(c.section.startLine) ?? -1).filter(i => i >= 0),
    [children, startLineToOrigIdx],
  );
  const allIndices = useMemo(
    () => (parentOrigIdx >= 0 ? [parentOrigIdx, ...childOrigIndices] : childOrigIndices),
    [parentOrigIdx, childOrigIndices],
  );
  const allChecked = onToggleGroup != null && allIndices.length > 0
    && allIndices.every(i => selectedSectionIndices?.has(i));
  const someChecked = !allChecked && allIndices.some(i => selectedSectionIndices?.has(i));

  const groupCheckboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (groupCheckboxRef.current) groupCheckboxRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const handleGroupToggle = useCallback(() => onToggleGroup?.(allIndices), [onToggleGroup, allIndices]);
  const stopGroupProp = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  // Auto-expand when active child exists
  useEffect(() => {
    if (hasActiveChild) setExpanded(true);
  }, [hasActiveChild]);

  const toggle = useCallback(() => {
    setExpanded(v => !v);
    setVisibleCount(EXPAND_PAGE_SIZE);
  }, []);

  const showMore = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setVisibleCount(v => v + EXPAND_PAGE_SIZE);
  }, []);

  const visible = expanded ? children.slice(0, visibleCount) : [];
  const hasMore = expanded && visibleCount < children.length;

  return (
    <div className={styles.parentGroup}>
      <button
        className={clsx(
          styles.parentHeader,
          listStyles.sectionRow,
          (isParentActive || hasActiveChild) && styles.parentHeaderActive,
        )}
        onClick={toggle}
        type="button"
        title={`${section.name} — ${children.length} services, ${totalLines.toLocaleString()} lines`}
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
        <span className={styles.parentName}>{section.name}</span>
        <span className={styles.sectionGroupBadge}>{children.length}</span>
        <span className={listStyles.sectionLine}>{totalLines.toLocaleString()}</span>
        <ChevronRight
          size={12}
          className={clsx(styles.sectionGroupChevron, expanded && styles.sectionGroupChevronOpen)}
        />
      </button>
      {expanded && (
        <div className={styles.parentChildren}>
          {visible.map(c => {
            const origIdx = startLineToOrigIdx.get(c.section.startLine) ?? -1;
            return (
              <SectionItem
                key={c.section.startLine}
                section={c.section}
                isActive={c.section.startLine === activeStartLine}
                jumpSeq={jumpSeq}
                startLine={c.section.startLine}
                onJump={onJump}
                isChild={true}
                originalIndex={origIdx}
                isSelected={origIdx >= 0 ? selectedSectionIndices?.has(origIdx) : false}
                onToggle={onToggleSection}
              />
            );
          })}
          {hasMore && (
            <button className={listStyles.showMoreBtn} onClick={showMore} type="button">
              Show more ({children.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export default ParentSection;
