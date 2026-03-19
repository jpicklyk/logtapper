import React from 'react';
import { Code, Columns2, Eye, WrapText } from 'lucide-react';
import { SegmentedControl, IconButton } from '../../ui';
import type { SegmentedOption } from '../../ui';
import type { EditorViewMode } from './EditorTab';
import styles from './EditorToolbar.module.css';

const VIEW_MODE_OPTIONS: SegmentedOption<EditorViewMode>[] = [
  { value: 'editor', icon: Code, tooltip: 'Editor' },
  { value: 'split', icon: Columns2, tooltip: 'Editor + Preview' },
  { value: 'preview', icon: Eye, tooltip: 'Preview' },
];

interface EditorToolbarProps {
  viewMode: EditorViewMode;
  onModeChange: (mode: EditorViewMode) => void;
  wordWrap: boolean;
  onWordWrapToggle: () => void;
}

export const EditorToolbar = React.memo(function EditorToolbar({
  viewMode,
  onModeChange,
  wordWrap,
  onWordWrapToggle,
}: EditorToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <IconButton
        icon={WrapText}
        size={14}
        active={wordWrap}
        onClick={onWordWrapToggle}
        title={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
      />
      <div className={styles.spacer} />
      <SegmentedControl
        options={VIEW_MODE_OPTIONS}
        value={viewMode}
        onChange={onModeChange}
        size="sm"
      />
    </div>
  );
});
