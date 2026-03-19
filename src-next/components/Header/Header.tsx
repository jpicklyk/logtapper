import React, { useState, useCallback, useEffect, useMemo } from 'react';
import clsx from 'clsx';
import { FolderOpen, FileEdit, Menu, Radio, Square, Smartphone, Download } from 'lucide-react';
import { useSession, useIsStreaming, useViewerActions } from '../../context';
import { listAdbDevices } from '../../bridge/commands';
import type { AdbDevice } from '../../bridge/types';
import { Modal } from '../../ui/Modal/Modal';
import { DropdownMenu } from '../../ui';
import type { MenuItem } from '../../ui';
import { SearchBar } from '../SearchBar';
import { ExportModal } from '../ExportModal';
import { bus } from '../../events';
import styles from './Header.module.css';

export const Header = React.memo(function Header() {
  const session = useSession();
  const isStreaming = useIsStreaming();
  const { openFileDialog, openInEditorDialog, startStream, stopStream, saveFile, saveFileAs } = useViewerActions();

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

  const fileMenuItems = useMemo<MenuItem[]>(() => [
    { id: 'open-log', label: 'Open Log...', icon: FolderOpen, shortcut: 'Ctrl+O' },
    { id: 'open-editor', label: 'Open in Editor...', icon: FileEdit, shortcut: 'Ctrl+Shift+O' },
    { separator: true },
    { id: 'save', label: isStreaming ? 'Save Capture' : 'Save', shortcut: 'Ctrl+S' },
    { id: 'save-as', label: 'Save As...', shortcut: 'Ctrl+Shift+S' },
    { separator: true },
    { id: 'export-session', label: 'Export Session...', icon: Download, shortcut: 'Ctrl+Shift+E', disabled: !session },
  ], [isStreaming, session]);

  const handleFileMenuSelect = useCallback((id: string) => {
    switch (id) {
      case 'open-log': openFileDialog(); break;
      case 'open-editor': openInEditorDialog(); break;
      case 'save': saveFile(); break;
      case 'save-as': saveFileAs(); break;
      case 'export-session': setShowExportModal(true); break;
    }
  }, [openFileDialog, openInEditorDialog, saveFile, saveFileAs]);

  useEffect(() => {
    const handler = () => { setShowExportModal(true); };
    bus.on('layout:export-session-requested', handler);
    return () => { bus.off('layout:export-session-requested', handler); };
  }, []);

  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <span className={styles.title}>
          <span className={styles.titleAndroid}>Android</span>
          {' '}Log<span className={styles.titleAccent}>Tapper</span>
        </span>
      </div>

      <div className={styles.searchArea}>
        <SearchBar disabled={!session} />
      </div>

      <div className={styles.actions}>
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
      </div>

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
        onClose={() => setShowExportModal(false)}
      />
    </header>
  );
});
