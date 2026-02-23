import { useState } from 'react';
import type { AppSettings, UseSettingsResult } from '../hooks/useSettings';
import { SETTING_DEFAULTS } from '../hooks/useSettings';
import type { UseAnonymizerConfigResult } from '../hooks/useAnonymizerConfig';

type SettingsTab = 'general' | 'pii';

interface Props {
  settings: AppSettings;
  onUpdate: UseSettingsResult['updateSetting'];
  onReset: UseSettingsResult['resetSettings'];
  onClose: () => void;
  anonymizerConfig: UseAnonymizerConfigResult;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Estimate memory cost for N cached ViewLine objects (~500 bytes each). */
function estimateCacheMB(lines: number): string {
  const bytes = lines * 500;
  if (bytes >= 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `~${(bytes / 1_000_000).toFixed(0)} MB`;
}

const BUILTIN_IDS = new Set([
  'email', 'mac', 'ipv4', 'ipv6', 'imei', 'android_id', 'serial',
  'jwt', 'api_keys', 'bearer_token', 'gaid', 'session_id', 'url_credentials', 'phone',
]);

const TIER_LABELS: Record<string, string> = {
  tier1: 'Tier 1 — Standard (low false positive)',
  tier2: 'Tier 2 — Keyword-anchored',
  tier3: 'Tier 3 — High false positive risk',
};

const TIER_BADGE_CLASS: Record<string, string> = {
  tier1: 'pii-fp-badge pii-fp-badge-tier1',
  tier2: 'pii-fp-badge pii-fp-badge-tier2',
  tier3: 'pii-fp-badge pii-fp-badge-tier3',
};

interface AddPatternState {
  label: string;
  regex: string;
  error: string | null;
  open: boolean;
}

export default function SettingsPanel({ settings, onUpdate, onReset, onClose, anonymizerConfig }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [expandedDetectors, setExpandedDetectors] = useState<Set<string>>(new Set());
  const [addPatternState, setAddPatternState] = useState<Record<string, AddPatternState>>({});
  const [addCustomState, setAddCustomState] = useState<{ label: string; regex: string; error: string | null }>({
    label: '',
    regex: '',
    error: null,
  });

  const {
    config,
    toggleDetector,
    togglePattern,
    addPatternToDetector,
    removePattern,
    addCustomDetector,
    removeCustomDetector,
  } = anonymizerConfig;

  const handleNumberInput = (
    key: keyof AppSettings,
    raw: string,
    fallback: number,
  ) => {
    const parsed = parseInt(raw.replace(/,/g, ''), 10);
    onUpdate(key, isNaN(parsed) || parsed < 1 ? fallback : parsed);
  };

  const toggleExpanded = (id: string) => {
    setExpandedDetectors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const getAddPatternState = (detectorId: string): AddPatternState => {
    return addPatternState[detectorId] ?? { label: '', regex: '', error: null, open: false };
  };

  const setAddPattern = (detectorId: string, patch: Partial<AddPatternState>) => {
    setAddPatternState((prev) => ({
      ...prev,
      [detectorId]: { ...getAddPatternState(detectorId), ...patch },
    }));
  };

  const handleAddPattern = (detectorId: string) => {
    const state = getAddPatternState(detectorId);
    const label = state.label.trim();
    const regex = state.regex.trim();
    if (!label || !regex) return;
    try {
      new RegExp(regex);
    } catch {
      setAddPattern(detectorId, { error: 'Invalid regex pattern' });
      return;
    }
    addPatternToDetector(detectorId, label, regex);
    setAddPattern(detectorId, { label: '', regex: '', error: null, open: false });
  };

  const handleAddCustomDetector = () => {
    const label = addCustomState.label.trim();
    const regex = addCustomState.regex.trim();
    if (!label || !regex) return;
    try {
      new RegExp(regex);
    } catch {
      setAddCustomState((prev) => ({ ...prev, error: 'Invalid regex pattern' }));
      return;
    }
    addCustomDetector(label, regex);
    setAddCustomState({ label: '', regex: '', error: null });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Settings</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {/* Tab bar */}
        <div className="settings-tabs">
          <button
            className={`settings-tab${activeTab === 'general' ? ' settings-tab-active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button
            className={`settings-tab${activeTab === 'pii' ? ' settings-tab-active' : ''}`}
            onClick={() => setActiveTab('pii')}
          >
            PII Anonymization
          </button>
        </div>

        <div className="settings-body">
          {/* ── General tab ── */}
          {activeTab === 'general' && (
            <>
              <div className="settings-section">
                <div className="settings-section-title">Viewer</div>

                <div className="settings-row">
                  <div className="settings-label">
                    <span className="settings-label-text">Line cache</span>
                    <span className="settings-label-hint">
                      Total lines cached in the viewer for both file and streaming modes. Distributed
                      by priority (focused view gets the largest share). Default: {formatNumber(SETTING_DEFAULTS.fileCacheBudget)}.
                    </span>
                  </div>
                  <div className="settings-control">
                    <input
                      type="number"
                      className="settings-input"
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
                    <span className="settings-unit">lines ({estimateCacheMB(settings.fileCacheBudget)})</span>
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-title">ADB Streaming</div>

                <div className="settings-row">
                  <div className="settings-label">
                    <span className="settings-label-text">Backend log buffer</span>
                    <span className="settings-label-hint">
                      Max raw log lines stored in the backend. Evicted lines are spilled to disk.
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
            </>
          )}

          {/* ── PII Anonymization tab ── */}
          {activeTab === 'pii' && (
            <div className="settings-section">
              {!config ? (
                <div className="settings-label-hint">Loading configuration…</div>
              ) : (
                <>
                  <div className="settings-label-hint" style={{ marginBottom: 12 }}>
                    Controls which patterns are detected when "Anonymize PII" is enabled in the processor panel.
                    Changes apply immediately to all future pipeline runs.
                  </div>

                  {/* Tier groups */}
                  {(['tier1', 'tier2', 'tier3'] as const).map((tier) => {
                    const detectors = config.detectors.filter((d) => d.tier === tier);
                    if (detectors.length === 0) return null;
                    return (
                      <div key={tier} className="pii-tier-group">
                        <div className="pii-tier-group-title">{TIER_LABELS[tier]}</div>
                        {detectors.map((detector) => {
                          const isExpanded = expandedDetectors.has(detector.id);
                          const aps = getAddPatternState(detector.id);
                          return (
                            <div key={detector.id} className="pii-detector-card">
                              <div className="pii-detector-header">
                                <input
                                  type="checkbox"
                                  checked={detector.enabled}
                                  onChange={(e) => toggleDetector(detector.id, e.target.checked)}
                                  title="Enable/disable this detector"
                                />
                                <span className="pii-detector-label">{detector.label}</span>
                                <span className={TIER_BADGE_CLASS[tier]}>{detector.fpHint}</span>
                                <button
                                  className="pii-detector-expand-btn"
                                  onClick={() => toggleExpanded(detector.id)}
                                >
                                  {isExpanded ? '▲' : '▼'} {detector.patterns.length} pattern{detector.patterns.length !== 1 ? 's' : ''}
                                </button>
                              </div>

                              {isExpanded && (
                                <div className="pii-pattern-list">
                                  {detector.patterns.map((pattern, idx) => (
                                    <div key={idx} className="pii-pattern-row">
                                      {pattern.builtin ? (
                                        <>
                                          <span className="pii-pattern-builtin-icon" title="Built-in pattern">&#128274;</span>
                                          <div className="pii-pattern-info">
                                            <div className="pii-pattern-label">{pattern.label}</div>
                                            <code className="pii-pattern-regex">{pattern.regex}</code>
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <input
                                            type="checkbox"
                                            checked={pattern.enabled}
                                            onChange={(e) => togglePattern(detector.id, idx, e.target.checked)}
                                            title="Enable/disable this pattern"
                                          />
                                          <div className="pii-pattern-info">
                                            <div className="pii-pattern-label">{pattern.label}</div>
                                            <code className="pii-pattern-regex">{pattern.regex}</code>
                                          </div>
                                          <button
                                            className="pii-pattern-del-btn"
                                            title="Remove pattern"
                                            onClick={() => removePattern(detector.id, idx)}
                                          >
                                            ×
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  ))}

                                  {/* Add pattern form */}
                                  {aps.open ? (
                                    <div className="pii-add-pattern-form">
                                      <div className="pii-add-pattern-row">
                                        <input
                                          className="pii-add-pattern-input"
                                          placeholder="Label (e.g. Custom Email)"
                                          value={aps.label}
                                          onChange={(e) => setAddPattern(detector.id, { label: e.target.value, error: null })}
                                        />
                                        <input
                                          className="pii-add-pattern-input"
                                          placeholder="Regex pattern"
                                          value={aps.regex}
                                          spellCheck={false}
                                          onChange={(e) => setAddPattern(detector.id, { regex: e.target.value, error: null })}
                                        />
                                        <button
                                          className="pii-add-btn"
                                          disabled={!aps.label.trim() || !aps.regex.trim()}
                                          onClick={() => handleAddPattern(detector.id)}
                                        >
                                          Add
                                        </button>
                                        <button
                                          className="pii-add-btn"
                                          style={{ background: 'var(--border)' }}
                                          onClick={() => setAddPattern(detector.id, { open: false, error: null })}
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                      {aps.error && <div className="pii-add-pattern-error">{aps.error}</div>}
                                    </div>
                                  ) : (
                                    <button
                                      className="pii-add-pattern-toggle"
                                      onClick={() => setAddPattern(detector.id, { open: true })}
                                    >
                                      + Add pattern
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}

                  {/* Custom Detectors section */}
                  <div className="pii-custom-section">
                    <div className="pii-custom-section-title">Custom Detectors</div>
                    {config.detectors.filter((d) => !BUILTIN_IDS.has(d.id)).length === 0 && (
                      <div className="settings-label-hint" style={{ marginBottom: 8 }}>
                        No custom detectors. Add one below.
                      </div>
                    )}
                    {config.detectors
                      .filter((d) => !BUILTIN_IDS.has(d.id))
                      .map((d) => (
                        <div key={d.id} className="pii-custom-entry">
                          <input
                            type="checkbox"
                            checked={d.enabled}
                            onChange={(e) => toggleDetector(d.id, e.target.checked)}
                          />
                          <span className="pii-custom-entry-label">{d.label}</span>
                          <button
                            className="pii-custom-del-btn"
                            title="Remove custom detector"
                            onClick={() => removeCustomDetector(d.id)}
                          >
                            ×
                          </button>
                        </div>
                      ))}

                    <div className="pii-add-custom-form">
                      <div className="pii-add-pattern-row">
                        <input
                          className="pii-add-pattern-input"
                          placeholder="Detector label (e.g. My Secret)"
                          value={addCustomState.label}
                          onChange={(e) => setAddCustomState((prev) => ({ ...prev, label: e.target.value, error: null }))}
                        />
                        <input
                          className="pii-add-pattern-input"
                          placeholder="Regex pattern (e.g. SECRET-\w+)"
                          value={addCustomState.regex}
                          spellCheck={false}
                          onChange={(e) => setAddCustomState((prev) => ({ ...prev, regex: e.target.value, error: null }))}
                        />
                        <button
                          className="pii-add-btn"
                          disabled={!addCustomState.label.trim() || !addCustomState.regex.trim()}
                          onClick={handleAddCustomDetector}
                        >
                          Add
                        </button>
                      </div>
                      {addCustomState.error && (
                        <div className="pii-add-pattern-error">{addCustomState.error}</div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="settings-footer">
          {activeTab === 'general' && (
            <button className="btn-secondary" onClick={onReset} title="Restore streaming settings to their default values">
              Reset to Defaults
            </button>
          )}
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
