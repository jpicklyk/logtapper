import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useLogViewer } from './hooks/useLogViewer';
import { usePipeline } from './hooks/usePipeline';
import { useClaude } from './hooks/useClaude';
import { usePaneLayout } from './hooks/usePaneLayout';
import { AppContext } from './context/AppContext';
import { getDumpstateMetadata, getSections } from './bridge/commands';
import type { DumpstateMetadata } from './bridge/types';
import type { SectionEntry } from './components/FileInfoPanel';
import PaneLayout from './components/PaneLayout';
import SearchBar from './components/SearchBar';
import ProgressOverlay from './components/ProgressOverlay';
import './App.css';

export default function App() {
  const viewer = useLogViewer();
  const pipeline = usePipeline();
  const claude = useClaude();
  const layout = usePaneLayout();

  const [processorViewId, setProcessorViewId] = useState<string | null>(null);
  const [sections, setSections] = useState<SectionEntry[]>([]);
  const [metadata, setMetadata] = useState<DumpstateMetadata | null>(null);

  // ── File open ──────────────────────────────────────────────────────────────

  const handleOpenFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Log Files', extensions: ['log', 'txt', 'gz'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected === 'string') {
      setMetadata(null);
      setSections([]);
      await viewer.loadFile(selected);
    }
  }, [viewer]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) {
        const path = (file as File & { path?: string }).path;
        if (path) {
          setMetadata(null);
          setSections([]);
          viewer.loadFile(path);
        }
      }
    },
    [viewer],
  );

  // ── Processor view ─────────────────────────────────────────────────────────

  const handleViewProcessor = useCallback((id: string) => {
    setProcessorViewId(id);
    viewer.setProcessorView(id);
  }, [viewer]);

  const handleClearProcessorView = useCallback(() => {
    setProcessorViewId(null);
    viewer.clearProcessorView();
  }, [viewer]);

  // ── Dashboard auto-open — fires once when the first results arrive ─────────

  const hadResultsRef = useRef(false);
  useEffect(() => {
    const hasResults = pipeline.lastResults.length > 0;
    if (hasResults && !hadResultsRef.current) {
      layout.openCenterTab('dashboard');
    }
    hadResultsRef.current = hasResults;
  }, [pipeline.lastResults.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Section detection (Bugreport/Dumpstate files) ─────────────────────────

  useEffect(() => {
    if (!viewer.session || viewer.session.sourceType !== 'Bugreport') {
      setSections([]);
      return;
    }
    getSections(viewer.session.sessionId)
      .then((secs) =>
        setSections(secs.map((s) => ({ lineNum: s.startLine, endLine: s.endLine, title: s.name })))
      )
      .catch(() => setSections([]));
  }, [viewer.session]);

  // ── Dumpstate metadata fetch ───────────────────────────────────────────────

  useEffect(() => {
    if (!viewer.session || viewer.session.sourceType !== 'Bugreport') return;
    getDumpstateMetadata(viewer.session.sessionId)
      .then(setMetadata)
      .catch(() => setMetadata(null));
  }, [viewer.session]);

  // ── Active section — derived from scroll position ─────────────────────────

  const activeSectionIndex = useMemo(() => {
    if (viewer.scrollToLine == null || sections.length === 0) return -1;
    const lineNum = viewer.scrollToLine;
    return sections.findIndex((s) => lineNum >= s.lineNum && lineNum <= s.endLine);
  }, [viewer.scrollToLine, sections]);

  // ── Context value ──────────────────────────────────────────────────────────

  const ctxValue = {
    viewer,
    pipeline,
    claude,
    metadata,
    processorViewId,
    sections,
    activeSectionIndex,
    onViewProcessor: handleViewProcessor,
    onClearProcessorView: handleClearProcessorView,
  };

  return (
    <AppContext.Provider value={ctxValue}>
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
            <button
              className="btn-reset-layout"
              onClick={layout.resetLayout}
              title="Clear saved layout and reset to defaults"
            >
              Reset Layout
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

        {/* ── Error banner ── */}
        {viewer.error && (
          <div className="error-banner">
            <strong>Error:</strong> {viewer.error}
          </div>
        )}

        {/* ── Pane layout ── */}
        <PaneLayout
          layout={layout}
          pipelineHasResults={pipeline.lastResults.length > 0}
        />

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
    </AppContext.Provider>
  );
}
