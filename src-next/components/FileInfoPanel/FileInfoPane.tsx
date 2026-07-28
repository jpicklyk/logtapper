import React, { useCallback } from 'react';
import { useFileInfo } from './useFileInfo';
import { FileInfoPanel } from './FileInfoPanel';
import { useFileActions } from '../../context';
import type { SourceType } from '../../bridge/types';

/**
 * Self-contained container. Owns all data-fetching for the File Info left-pane
 * tab. Rendered only when the tab is active, so streaming updates never
 * re-render LeftPane.
 */
interface FileInfoPaneProps {
  paneId: string | null;
}

const FileInfoPane = React.memo(function FileInfoPane({ paneId }: FileInfoPaneProps) {
  const fileInfo = useFileInfo(paneId);
  const { loadFile } = useFileActions();

  // Reopening is the only way to change a session's source type: the line index
  // was built with the parser the detected type selected, so every LineMeta
  // would be stale if the type were swapped in place.
  const { filePath, isStreamingSession } = fileInfo;
  const canReopen = !!filePath && !isStreamingSession;
  const onReopenAs = useCallback(
    (t: SourceType) => {
      if (!filePath) return;
      void loadFile(filePath, paneId ?? undefined, undefined, t);
    },
    [loadFile, filePath, paneId],
  );

  return (
    <FileInfoPanel
      sourceName={fileInfo.sourceName}
      sourceType={fileInfo.sourceType}
      onReopenAs={canReopen ? onReopenAs : undefined}
      totalLines={fileInfo.totalLines}
      fileSize={fileInfo.fileSize}
      lostLineCount={fileInfo.lostLineCount}
      firstTimestamp={fileInfo.firstTimestamp}
      lastTimestamp={fileInfo.lastTimestamp}
      sections={fileInfo.sections}
      dumpstateMetadata={fileInfo.dumpstateMetadata}
      activeSectionIndex={fileInfo.activeSectionIndex}
      sectionJumpSeq={fileInfo.sectionJumpSeq}
      indexingProgress={fileInfo.indexingProgress}
      onJumpToLine={fileInfo.onJumpToLine}
      selectedSectionIndices={fileInfo.selectedSectionIndices}
      onToggleSection={fileInfo.toggleSection}
      onToggleGroup={fileInfo.toggleGroup}
      onClearSectionFilter={fileInfo.clearSectionFilter}
      isSectionFilterActive={fileInfo.isSectionFilterActive}
    />
  );
});

export default FileInfoPane;
