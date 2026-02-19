import type { AppSettings, UseSettingsResult } from '../hooks/useSettings';
import { SETTING_DEFAULTS } from '../hooks/useSettings';

interface Props {
  settings: AppSettings;
  onUpdate: UseSettingsResult['updateSetting'];
  onReset: UseSettingsResult['resetSettings'];
  onClose: () => void;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export default function SettingsPanel({ settings, onUpdate, onReset, onClose }: Props) {
  const handleNumberInput = (
    key: keyof AppSettings,
    raw: string,
    fallback: number,
  ) => {
    const parsed = parseInt(raw.replace(/,/g, ''), 10);
    onUpdate(key, isNaN(parsed) || parsed < 1 ? fallback : parsed);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Settings</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-body">
          {/* ── Streaming ── */}
          <div className="settings-section">
            <div className="settings-section-title">Streaming</div>

            <div className="settings-row">
              <div className="settings-label">
                <span className="settings-label-text">Frontend line cache</span>
                <span className="settings-label-hint">
                  Max lines held in viewer memory. Oldest lines are dropped when exceeded.
                  Default: {formatNumber(SETTING_DEFAULTS.streamFrontendCacheMax)}.
                </span>
              </div>
              <div className="settings-control">
                <input
                  type="number"
                  className="settings-input"
                  value={settings.streamFrontendCacheMax}
                  min={1_000}
                  max={1_000_000}
                  step={5_000}
                  onChange={(e) =>
                    handleNumberInput(
                      'streamFrontendCacheMax',
                      e.target.value,
                      SETTING_DEFAULTS.streamFrontendCacheMax,
                    )
                  }
                />
                <span className="settings-unit">lines</span>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label">
                <span className="settings-label-text">Backend log buffer</span>
                <span className="settings-label-hint">
                  Max raw log lines stored in the backend. Oldest lines are evicted when exceeded.
                  Default: {formatNumber(SETTING_DEFAULTS.streamBackendLineMax)}.
                </span>
              </div>
              <div className="settings-control">
                <input
                  type="number"
                  className="settings-input"
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
                <span className="settings-unit">lines</span>
              </div>
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button className="btn-secondary" onClick={onReset} title="Restore all settings to their default values">
            Reset to Defaults
          </button>
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
