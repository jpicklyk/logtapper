import { memo, useCallback } from 'react';
import type { AppSettings, UseSettingsResult } from '../../hooks';
import { SETTING_DEFAULTS } from '../../hooks';
import css from './SettingsPanel.module.css';

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function estimateCacheMB(lines: number): string {
  const bytes = lines * 500;
  if (bytes >= 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `~${(bytes / 1_000_000).toFixed(0)} MB`;
}

interface GeneralTabProps {
  settings: AppSettings;
  onUpdate: UseSettingsResult['updateSetting'];
}

export const GeneralTab = memo(function GeneralTab({ settings, onUpdate }: GeneralTabProps) {
  const handleNumberInput = useCallback(
    (key: keyof AppSettings, raw: string, fallback: number) => {
      const parsed = parseInt(raw.replace(/,/g, ''), 10);
      onUpdate(key, isNaN(parsed) || parsed < 1 ? fallback : parsed);
    },
    [onUpdate],
  );

  return (
    <>
      <div className={css.section}>
        <div className={css.sectionTitle}>Viewer</div>
        <div className={css.row}>
          <div className={css.label}>
            <span className={css.labelText}>Line cache</span>
            <span className={css.labelHint}>
              Total lines cached in the viewer for both file and streaming modes.
              Default: {formatNumber(SETTING_DEFAULTS.fileCacheBudget)}.
            </span>
          </div>
          <div className={css.control}>
            <input
              type="number"
              className={css.input}
              value={settings.fileCacheBudget}
              min={10_000}
              max={1_000_000}
              step={10_000}
              onChange={(e) =>
                handleNumberInput(
                  'fileCacheBudget',
                  e.target.value,
                  SETTING_DEFAULTS.fileCacheBudget,
                )
              }
            />
            <span className={css.unit}>
              lines ({estimateCacheMB(settings.fileCacheBudget)})
            </span>
          </div>
        </div>
      </div>

      <div className={css.section}>
        <div className={css.sectionTitle}>ADB Streaming</div>
        <div className={css.row}>
          <div className={css.label}>
            <span className={css.labelText}>Backend log buffer</span>
            <span className={css.labelHint}>
              Max raw log lines stored in the backend. Evicted lines are spilled to disk.
              Default: {formatNumber(SETTING_DEFAULTS.streamBackendLineMax)}.
            </span>
          </div>
          <div className={css.control}>
            <input
              type="number"
              className={css.input}
              value={settings.streamBackendLineMax}
              min={10_000}
              max={5_000_000}
              step={50_000}
              onChange={(e) =>
                handleNumberInput(
                  'streamBackendLineMax',
                  e.target.value,
                  SETTING_DEFAULTS.streamBackendLineMax,
                )
              }
            />
            <span className={css.unit}>lines</span>
          </div>
        </div>
        <div className={css.row}>
          <div className={css.label}>
            <span className={css.labelText}>Auto-reconnect on disconnect</span>
            <span className={css.labelHint}>
              Automatically restart the stream after an unexpected EOF (e.g. screen unlock
              USB reset). Stops retrying after 5 consecutive quick failures.
            </span>
          </div>
          <div className={css.control}>
            <input
              type="checkbox"
              checked={settings.autoReconnectStream}
              onChange={(e) => onUpdate('autoReconnectStream', e.target.checked)}
            />
          </div>
        </div>
      </div>
    </>
  );
});
