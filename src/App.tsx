import { useCallback, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import LogViewer from './components/LogViewer';
import SearchBar from './components/SearchBar';
import ProgressOverlay from './components/ProgressOverlay';
import ProcessorPanel from './components/ProcessorPanel';
import ProcessorDashboard from './components/ProcessorDashboard';
import ChatPanel from './components/ChatPanel';
import ProcessorMarketplace from './components/ProcessorMarketplace';
import { useLogViewer } from './hooks/useLogViewer';
import { usePipeline } from './hooks/usePipeline';
import { useClaude } from './hooks/useClaude';
import './App.css';

type SidePanel = 'processors' | 'dashboard' | 'chat' | 'marketplace' | null;

export default function App() {
  const viewer = useLogViewer();
  const pipeline = usePipeline();
  const claude = useClaude();
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [processorViewId, setProcessorViewId] = useState<string | null>(null);

  const handleOpenFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Log Files', extensions: ['log', 'txt', 'gz'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected === 'string') {
      await viewer.loadFile(selected);
    }
  }, [viewer]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) {
        const path = (file as File & { path?: string }).path;
        if (path) viewer.loadFile(path);
      }
    },
    [viewer],
  );

  const handleViewProcessor = useCallback((id: string) => {
    setProcessorViewId(id);
    viewer.setProcessorView(id);
  }, [viewer]);

  const handleClearProcessorView = useCallback(() => {
    setProcessorViewId(null);
    viewer.clearProcessorView();
  }, [viewer]);

  const togglePanel = (panel: SidePanel) =>
    setSidePanel((p) => (p === panel ? null : panel));

  return (
    <div
      className="app-layout"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-left">
          <span className="app-title">LogTapper</span>
          {viewer.session && (
            <span className="session-info">
              {viewer.session.sourceName} —{' '}
              {viewer.session.totalLines.toLocaleString()} lines
            </span>
          )}
          {processorViewId && (
            <span className="proc-view-badge">
              Processor: {processorViewId}{' '}
              <button className="proc-view-clear" onClick={handleClearProcessorView}>×</button>
            </span>
          )}
        </div>
        <div className="header-right">
          {viewer.session && (
            <>
              <button
                className={`btn-icon-header${sidePanel === 'processors' ? ' active' : ''}`}
                title="Processors"
                onClick={() => togglePanel('processors')}
              >
                ⚙
              </button>
              <button
                className={`btn-icon-header${sidePanel === 'dashboard' ? ' active' : ''}`}
                title="Dashboard"
                onClick={() => togglePanel('dashboard')}
                disabled={pipeline.lastResults.length === 0}
              >
                ◫
              </button>
              <button
                className={`btn-icon-header${sidePanel === 'chat' ? ' active' : ''}`}
                title="Claude Analysis"
                onClick={() => togglePanel('chat')}
              >
                ✦
              </button>
            </>
          )}
          <button
            className={`btn-icon-header${sidePanel === 'marketplace' ? ' active' : ''}`}
            title="Processor Marketplace"
            onClick={() => togglePanel('marketplace')}
          >
            ⊞
          </button>
          <button className="btn-primary" onClick={handleOpenFile}>
            Open Log File
          </button>
        </div>
      </header>

      {/* ── Search bar ── */}
      <div className="search-row">
        <SearchBar
          onSearch={viewer.handleSearch}
          summary={viewer.searchSummary}
          onJumpToMatch={viewer.jumpToMatch}
          currentMatchIndex={viewer.currentMatchIndex}
          disabled={!viewer.session}
        />
      </div>

      {/* ── Body (viewer + optional side panel) ── */}
      <div className="app-body">
        {/* ── Main content ── */}
        <main className="app-main">
          {viewer.error && (
            <div className="error-banner">
              <strong>Error:</strong> {viewer.error}
            </div>
          )}

          {!viewer.session && !viewer.loading && (
            <div className="drop-zone">
              <div className="drop-zone-content">
                <p className="drop-zone-icon">📂</p>
                <p>Drag a log file here or click <strong>Open Log File</strong></p>
                <p className="drop-zone-hint">
                  Supports logcat, kernel (dmesg), radio, and bugreport files
                </p>
              </div>
            </div>
          )}

          <LogViewer
            sessionId={viewer.session?.sessionId ?? ''}
            totalLines={viewer.session?.totalLines ?? 0}
            lineCache={viewer.lineCache}
            search={viewer.search ?? undefined}
            onFetchNeeded={viewer.handleFetchNeeded}
            onLineClick={viewer.jumpToLine}
            scrollToLine={viewer.scrollToLine}
            processorId={processorViewId ?? undefined}
          />
        </main>

        {/* ── Side panel ── */}
        {sidePanel && (
          <aside className="side-panel">
            {sidePanel === 'processors' && (
              <ProcessorPanel
                pipeline={pipeline}
                sessionId={viewer.session?.sessionId ?? null}
              />
            )}
            {sidePanel === 'dashboard' && viewer.session && (
              <ProcessorDashboard
                pipeline={pipeline}
                sessionId={viewer.session.sessionId}
                onViewProcessor={handleViewProcessor}
                onJumpToLine={viewer.jumpToLine}
              />
            )}
            {sidePanel === 'chat' && (
              <ChatPanel
                claude={claude}
                sessionId={viewer.session?.sessionId ?? null}
                processorId={processorViewId}
              />
            )}
            {sidePanel === 'marketplace' && (
              <ProcessorMarketplace pipeline={pipeline} />
            )}
          </aside>
        )}
      </div>

      {/* ── Status bar ── */}
      {viewer.session && (
        <footer className="status-bar">
          <span>{viewer.session.sourceType}</span>
          <span>{viewer.session.totalLines.toLocaleString()} lines</span>
          {viewer.searchSummary && (
            <span>{viewer.searchSummary.totalMatches.toLocaleString()} matches</span>
          )}
          {pipeline.lastResults.length > 0 && (
            <span>
              {pipeline.lastResults
                .map((r) => `${r.processorId}: ${r.matchedLines.toLocaleString()} matched`)
                .join(' · ')}
            </span>
          )}
        </footer>
      )}

      {/* ── Loading overlay ── */}
      {viewer.loading && <ProgressOverlay message="Loading log file…" />}
    </div>
  );
}
