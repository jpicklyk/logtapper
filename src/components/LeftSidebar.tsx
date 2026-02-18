import { useAppContext } from '../context/AppContext';
import FileInfoPanel from './FileInfoPanel';

interface Props {
  width: number;
}

export default function LeftSidebar({ width }: Props) {
  const { viewer, sections, metadata, activeSectionIndex } = useAppContext();

  return (
    <div className="left-sidebar" style={{ width }}>
      {viewer.session ? (
        <FileInfoPanel
          session={viewer.session}
          sections={sections}
          onJumpToSection={viewer.jumpToLine}
          metadata={metadata}
          activeSectionIndex={activeSectionIndex}
          sectionJumpSeq={viewer.jumpSeq}
        />
      ) : (
        <div className="sidebar-empty">
          <span className="sidebar-empty-icon">📂</span>
          <span>Open a log file</span>
        </div>
      )}
    </div>
  );
}
