import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import LogViewer from './components/LogViewer';
import SearchBar from './components/SearchBar';
import ProgressOverlay from './components/ProgressOverlay';
import { useLogViewer } from './hooks/useLogViewer';
import './App.css';

export default function App() {
  const viewer = useLogViewer();

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
        // Tauri exposes the real path via webkitRelativePath or via the file object
        const path = (file as File & { path?: string }).path;
        if (path) viewer.loadFile(path);
      }
    },
    [viewer],
  );

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
        </div>
        <div className="header-right">
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
        />
      </main>

      {/* ── Status bar ── */}
      {viewer.session && (
        <footer className="status-bar">
          <span>{viewer.session.sourceType}</span>
          <span>{viewer.session.totalLines.toLocaleString()} lines</span>
          {viewer.searchSummary && (
            <span>{viewer.searchSummary.totalMatches.toLocaleString()} matches</span>
          )}
        </footer>
      )}

      {/* ── Loading overlay ── */}
      {viewer.loading && <ProgressOverlay message="Loading log file…" />}
    </div>
  );
}
