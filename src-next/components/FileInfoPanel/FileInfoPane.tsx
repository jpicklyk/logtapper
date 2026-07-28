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
  const { loadFile, closeSession } = useFileActions();

  // Reopening is the only way to change a session's source type: the line index
  // was built with the parser the detected type selected, so every LineMeta
  // would be stale if the type were swapped in place.
  //
  // `.lts` sessions are excluded because the backend rejects an override for
  // them — each embedded session carries the type it was captured with — and
  // offering a control that always errors would also strand the placeholder tab
  // `session:loading` creates.
  const { filePath, isStreamingSession } = fileInfo;
  const canReopen =
    !!filePath && !isStreamingSession && !filePath.toLowerCase().endsWith('.lts');

  const onReopenAs = useCallback(
    (t: SourceType) => {
      if (!filePath) return;
      // Close first, then load. Reopening is a REPLACE, but `loadFile` treats a
      // pane that already holds a session as "open another tab" — which would
      // leave two tabs and, before the override joined session identity, two
      // tabs pointing at the same id. Closing first puts the pane in the
      // no-previous-session state, so the load takes the ordinary fresh-open
      // path: the old session's cache views are released and the new session
      // (which now has a distinct id, because the override is part of the
      // identity) gets its own tab.
      void (async () => {
        try {
          await closeSession(paneId ?? undefined);
        } catch {
          // Fall through and load anyway — the backend closes stale sessions
          // for this path on open regardless.
        }
        await loadFile(filePath, paneId ?? undefined, undefined, t);
      })();
    },
    [loadFile, closeSession, filePath, paneId],
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
