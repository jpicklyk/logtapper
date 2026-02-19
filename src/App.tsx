import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useLogViewer } from './hooks/useLogViewer';
import { usePipeline } from './hooks/usePipeline';
import { useClaude } from './hooks/useClaude';
import { usePaneLayout } from './hooks/usePaneLayout';
import { useSettings } from './hooks/useSettings';
import { useAnonymizerConfig } from './hooks/useAnonymizerConfig';
import { AppContext } from './context/AppContext';
import { getDumpstateMetadata, getSections, listAdbDevices } from './bridge/commands';
import type { AdbDevice, DumpstateMetadata } from './bridge/types';
import type { SectionEntry } from './components/FileInfoPanel';
import PaneLayout from './components/PaneLayout';
import SearchBar from './components/SearchBar';
import ProgressOverlay from './components/ProgressOverlay';
import SettingsPanel from './components/SettingsPanel';
import './App.css';

export default function App() {
  const { settings, updateSetting, resetSettings } = useSettings();
  const anonymizerConfig = useAnonymizerConfig();
  const viewer = useLogViewer(settings.streamFrontendCacheMax);
  const pipeline = usePipeline();
  const claude = useClaude();
  const layout = usePaneLayout();

  const [processorViewId, setProcessorViewId] = useState<string | null>(null);
  const [sections, setSections] = useState<SectionEntry[]>([]);
  const [metadata, setMetadata] = useState<DumpstateMetadata | null>(null);
  const [deviceList, setDeviceList] = useState<AdbDevice[]>([]);
  const [showDeviceSelector, setShowDeviceSelector] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [adbError, setAdbError] = useState<string | null>(null);

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

  // ── ADB streaming ──────────────────────────────────────────────────────────

  const startStreamWithDevice = useCallback(async (deviceId: string) => {
    setAdbError(null);
    setMetadata(null);
    setSections([]);
    await viewer.startStream(
      deviceId,
      undefined,
      Array.from(pipeline.activeProcessorIds),
      settings.streamBackendLineMax,
    );
  }, [viewer, pipeline.activeProcessorIds, settings.streamBackendLineMax]);

  const handleStreamAdb = useCallback(async () => {
    setAdbError(null);
    try {
      const devices = await listAdbDevices();
      if (devices.length === 0) {
        setAdbError('No ADB devices found. Connect a device and enable USB debugging.');
        return;
      }
      if (devices.length === 1) {
        await startStreamWithDevice(devices[0].serial);
      } else {
        setDeviceList(devices);
        setShowDeviceSelector(true);
      }
    } catch (e) {
      setAdbError(String(e));
    }
  }, [startStreamWithDevice]);

  const handleStopStream = useCallback(async () => {
    await viewer.stopStream();
  }, [viewer]);

  const handleDeviceSelect = useCallback(async (device: AdbDevice) => {
    setShowDeviceSelector(false);
    setDeviceList([]);
    await startStreamWithDevice(device.serial);
  }, [startStreamWithDevice]);

  // ── Processor view ─────────────────────────────────────────────────────────

  const handleViewProcessor = useCallback((id: string) => {
    setProcessorViewId(id);
    viewer.setProcessorView(id);
  }, [viewer]);

  const handleClearProcessorView = useCallback(() => {
    setProcessorViewId(null);
    viewer.clearProcessorView();
  }, [viewer]);

  // ── Rename logviewer tabs to filename when a file is loaded ──────────────

  useEffect(() => {
    if (!viewer.session?.sourceName) return;
    const name = viewer.session.sourceName;
    for (const pane of layout.panes) {
      for (const tab of pane.tabs) {
        if (tab.type === 'logviewer') {
          layout.renameTab(tab.id, name);
        }
      }
    }
  }, [viewer.session?.sourceName]); // eslint-disable-line react-hooks/exhaustive-deps

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
                {viewer.isStreaming && <span className="stream-dot" title="Streaming" />}
                {viewer.session.sourceName} —{' '}
                {viewer.session.totalLines.toLocaleString()} lines
                {viewer.isStreaming && <span className="stream-label">live</span>}
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
            <button
              className="btn-icon-header"
              onClick={() => setShowSettings(true)}
              title="Settings"
              aria-label="Open Settings"
            >
              ⚙
            </button>
            {viewer.isStreaming ? (
              <button className="btn-stop-stream" onClick={handleStopStream}>
                ■ Stop Stream
              </button>
            ) : (
              <button className="btn-stream-adb" onClick={handleStreamAdb}>
                ▶ Stream ADB
              </button>
            )}
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

        {/* ── Error banners ── */}
        {viewer.error && (
          <div className="error-banner">
            <strong>Error:</strong> {viewer.error}
          </div>
        )}
        {adbError && (
          <div className="error-banner">
            <strong>ADB:</strong> {adbError}{' '}
            <button className="error-banner-dismiss" onClick={() => setAdbError(null)}>×</button>
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

        {/* ── Settings panel ── */}
        {showSettings && (
          <SettingsPanel
            settings={settings}
            onUpdate={updateSetting}
            onReset={resetSettings}
            onClose={() => setShowSettings(false)}
            anonymizerConfig={anonymizerConfig}
          />
        )}

        {/* ── ADB device selector modal ── */}
        {showDeviceSelector && (
          <div className="modal-backdrop" onClick={() => setShowDeviceSelector(false)}>
            <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Select ADB Device</span>
                <button className="modal-close" onClick={() => setShowDeviceSelector(false)}>×</button>
              </div>
              <div className="modal-body">
                {deviceList.map((device) => (
                  <button
                    key={device.serial}
                    className="device-item"
                    onClick={() => handleDeviceSelect(device)}
                  >
                    <span className="device-model">{device.model || device.serial}</span>
                    <span className="device-serial">{device.serial}</span>
                    <span className={`device-state device-state--${device.state}`}>{device.state}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppContext.Provider>
  );
}
