import React, { useState, useCallback, useEffect, useMemo } from 'react';
import clsx from 'clsx';
import { FolderOpen, FilePen, Menu, Radio, Square, Smartphone, Download, Settings, Minus, Copy, X, FilePlus2, Save } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useSession, useIsStreaming, useViewerActions } from '../../context';
import { listAdbDevices } from '../../bridge/commands';
import type { AdbDevice } from '../../bridge/types';
import { isMac } from '../../bridge/platform';
import { Modal } from '../../ui/Modal/Modal';
import { DropdownMenu } from '../../ui';
import type { MenuItem } from '../../ui';
import { SearchBar } from '../SearchBar';
import { ExportModal } from '../ExportModal';
import { WorkspaceSwitcher } from '../WorkspaceSwitcher';
import { bus } from '../../events';
import styles from './Header.module.css';

/** Custom window control buttons for Windows/Linux (no native title bar). */
const WindowControls = React.memo(function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const win = getCurrentWindow();
    win.isMaximized().then((m) => { if (!cancelled) setMaximized(m); });


    win.onResized(() => {
      if (cancelled) return;
      win.isMaximized().then((m) => { if (!cancelled) setMaximized(m); });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleMinimize = useCallback(() => { getCurrentWindow().minimize(); }, []);
  const handleMaximize = useCallback(() => { getCurrentWindow().toggleMaximize(); }, []);
  const handleClose = useCallback(() => { getCurrentWindow().close(); }, []);

  return (
    <div className={styles.windowControls}>
      <button className={styles.winBtn} onClick={handleMinimize} title="Minimize">
        <Minus size={14} />
      </button>
      <button className={styles.winBtn} onClick={handleMaximize} title={maximized ? 'Restore' : 'Maximize'}>
        {maximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button className={clsx(styles.winBtn, styles.winBtnClose)} onClick={handleClose} title="Close">
        <X size={14} />
      </button>
    </div>
  );
});

export const Header = React.memo(function Header() {
  const session = useSession();
  const isStreaming = useIsStreaming();
  const { openFileDialog, openInEditorDialog, startStream, stopStream, saveFile, saveFileAs,
          newWorkspace, openWorkspace, saveWorkspace, saveWorkspaceAs } = useViewerActions();

  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  const [devices, setDevices] = useState<AdbDevice[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const handleStreamClick = useCallback(async () => {
    if (isStreaming) {
      await stopStream();
      return;
    }

    setLoadingDevices(true);
    setDeviceError(null);
    try {
      const found = await listAdbDevices();
      if (found.length === 0) {
        setDeviceError('No ADB devices connected.');
        setShowPicker(true);
        setDevices([]);
      } else if (found.length === 1) {
        await startStream(found[0].serial);
      } else {
        setDevices(found);
        setShowPicker(true);
      }
    } catch (e) {
      setDeviceError(String(e));
      setShowPicker(true);
      setDevices([]);
    } finally {
      setLoadingDevices(false);
    }
  }, [isStreaming, stopStream, startStream]);

  const handleSelectDevice = useCallback(async (serial: string) => {
    setShowPicker(false);
    await startStream(serial);
  }, [startStream]);

  const handleClosePicker = useCallback(() => {
    setShowPicker(false);
    setDeviceError(null);
  }, []);

  const handleCloseExportModal = useCallback(() => {
    setShowExportModal(false);
  }, []);

  const fileMenuItems = useMemo<MenuItem[]>(() => [
    { id: 'new-workspace', label: 'New Workspace', icon: FilePlus2, shortcut: 'Ctrl+N' },
    { id: 'open-workspace', label: 'Open Workspace...', icon: FolderOpen },
    { separator: true },
    { id: 'open-log', label: 'Open Log...', icon: FolderOpen, shortcut: 'Ctrl+O' },
    { id: 'open-editor', label: 'Open in Editor...', icon: FilePen, shortcut: 'Ctrl+Shift+O' },
    { separator: true },
    { id: 'save', label: isStreaming ? 'Save Capture' : 'Save', shortcut: 'Ctrl+S' },
    { id: 'save-as', label: 'Save As...' },
    { separator: true },
    { id: 'save-workspace', label: 'Save Workspace', icon: Save, shortcut: 'Ctrl+Shift+S' },
    { id: 'save-workspace-as', label: 'Save Workspace As...' },
    { separator: true },
    { id: 'export-session', label: 'Export Session...', icon: Download, shortcut: 'Ctrl+Shift+E', disabled: !session?.sessionId },
  ], [isStreaming, session?.sessionId]);

  const handleFileMenuSelect = useCallback((id: string) => {
    switch (id) {
      case 'new-workspace': newWorkspace(); break;
      case 'open-workspace': openWorkspace(); break;
      case 'open-log': openFileDialog(); break;
      case 'open-editor': openInEditorDialog(); break;
      case 'save': saveFile(); break;
      case 'save-as': saveFileAs(); break;
      case 'save-workspace': saveWorkspace(); break;
      case 'save-workspace-as': saveWorkspaceAs(); break;
      case 'export-session': setShowExportModal(true); break;
    }
  }, [newWorkspace, openWorkspace, openFileDialog, openInEditorDialog, saveFile, saveFileAs,
      saveWorkspace, saveWorkspaceAs]);

  useEffect(() => {
    const handler = () => { setShowExportModal(true); };
    bus.on('layout:export-session-requested', handler);
    return () => { bus.off('layout:export-session-requested', handler); };
  }, []);

  return (
    <header className={styles.header}>
      <div className={clsx(styles.brand, isMac && styles.brandMac)}>
        <span className={styles.title}>
          Log<span className={styles.titleAccent}>Tapper</span>
        </span>
        <DropdownMenu
          trigger={
            <button className={styles.actionBtn} title="Menu">
              <Menu size={16} />
            </button>
          }
          items={fileMenuItems}
          onSelect={handleFileMenuSelect}
          open={fileMenuOpen}
          onOpenChange={setFileMenuOpen}
        />
        <WorkspaceSwitcher />
      </div>

      <div className={styles.searchArea}>
        <SearchBar disabled={!session} />
      </div>

      <div className={styles.actions}>
        <button
          className={clsx(
            styles.actionBtn,
            isStreaming && styles.actionBtnStreaming,
            !isStreaming && loadingDevices && styles.actionBtnLoading,
          )}
          onClick={handleStreamClick}
          disabled={loadingDevices}
          title={isStreaming ? 'Stop ADB stream' : 'Start ADB stream'}
        >
          {isStreaming ? (
            <>
              <span className={styles.streamDot} />
              <Square size={11} fill="currentColor" />
              <span>Stop</span>
            </>
          ) : (
            <>
              <Radio size={14} />
              <span>{loadingDevices ? 'Connecting…' : 'Stream'}</span>
            </>
          )}
        </button>
        <button
          className={styles.actionBtn}
          onClick={() => bus.emit('layout:settings-requested')}
          title="Settings"
        >
          <Settings size={16} />
        </button>
      </div>

      {!isMac && <WindowControls />}

      <Modal
        open={showPicker}
        onClose={handleClosePicker}
        title="Select ADB Device"
        width={360}
      >
        {deviceError ? (
          <p className={styles.deviceError}>{deviceError}</p>
        ) : (
          <ul className={styles.deviceList}>
            {devices.map((d) => (
              <li key={d.serial}>
                <button
                  className={styles.deviceItem}
                  onClick={() => handleSelectDevice(d.serial)}
                >
                  <Smartphone size={15} className={styles.deviceIcon} />
                  <span className={styles.deviceModel}>{d.model || d.serial}</span>
                  <span className={styles.deviceSerial}>{d.serial}</span>
                  <span className={clsx(
                    styles.deviceState,
                    d.state === 'device' && styles.deviceStateOnline,
                  )}>
                    {d.state}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <ExportModal
        open={showExportModal}
        onClose={handleCloseExportModal}
      />
    </header>
  );
});
