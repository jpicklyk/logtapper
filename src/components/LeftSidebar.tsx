import { useState } from 'react';
import { useAppContext } from '../context/AppContext';
import FileInfoPanel from './FileInfoPanel';
import StatePanel from './StatePanel';

interface Props {
  width: number;
}

type SidebarTab = 'info' | 'state';

export default function LeftSidebar({ width }: Props) {
  const { viewer, sections, metadata, activeSectionIndex, pipeline } = useAppContext();
  const [activeTab, setActiveTab] = useState<SidebarTab>('info');

  const hasActiveTrackers = pipeline.processors.some(
    (p) => p.processorType === 'state_tracker' && pipeline.activeProcessorIds.has(p.id),
  );

  return (
    <div className="left-sidebar" style={{ width }}>
      {viewer.session && hasActiveTrackers && (
        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab${activeTab === 'info' ? ' sidebar-tab-active' : ''}`}
            onClick={() => setActiveTab('info')}
          >
            Info
          </button>
          <button
            className={`sidebar-tab${activeTab === 'state' ? ' sidebar-tab-active' : ''}`}
            onClick={() => setActiveTab('state')}
          >
            State
          </button>
          <div
            className="sidebar-tab-indicator"
            style={{ transform: `translateX(${activeTab === 'state' ? '100%' : '0%'})` }}
          />
        </div>
      )}
      {activeTab === 'info' || !hasActiveTrackers || !viewer.session ? (
        viewer.session ? (
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
        )
      ) : (
        <StatePanel />
      )}
    </div>
  );
}
