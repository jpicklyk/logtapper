import React from 'react';
import { useFileInfo } from './useFileInfo';
import { FileInfoPanel } from './FileInfoPanel';

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
  return (
    <FileInfoPanel
      sourceName={fileInfo.sourceName}
      sourceType={fileInfo.sourceType}
      totalLines={fileInfo.totalLines}
      fileSize={fileInfo.fileSize}
      firstTimestamp={fileInfo.firstTimestamp}
      lastTimestamp={fileInfo.lastTimestamp}
      sections={fileInfo.sections}
      dumpstateMetadata={fileInfo.dumpstateMetadata}
      activeSectionIndex={fileInfo.activeSectionIndex}
      sectionJumpSeq={fileInfo.sectionJumpSeq}
      indexingProgress={fileInfo.indexingProgress}
      onJumpToLine={fileInfo.onJumpToLine}
    />
  );
});

export default FileInfoPane;
