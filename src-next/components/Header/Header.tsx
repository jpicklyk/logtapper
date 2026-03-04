import React, { useState, useCallback } from 'react';
import clsx from 'clsx';
import { FolderOpen, Radio, Square, Smartphone } from 'lucide-react';
import { useSession, useIsStreaming, useViewerActions } from '../../context';
import { listAdbDevices } from '../../bridge/commands';
import type { AdbDevice } from '../../bridge/types';
import { Modal } from '../../ui/Modal/Modal';
import { SearchBar } from '../SearchBar';
import styles from './Header.module.css';

export const Header = React.memo(function Header() {
  const session = useSession();
  const isStreaming = useIsStreaming();
  const { openFileDialog, startStream, stopStream } = useViewerActions();

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
        <button
          className={styles.actionBtn}
          onClick={openFileDialog}
          title="Open log file"
        >
          <FolderOpen size={14} />
          <span>Open</span>
        </button>
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
    </header>
  );
});
