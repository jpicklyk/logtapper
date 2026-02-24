import { memo, useState, useCallback } from 'react';
import type { AppSettings, UseSettingsResult } from '../../hooks/useSettings';
import { SETTING_DEFAULTS } from '../../hooks/useSettings';
import type { UseAnonymizerConfigResult } from '../../hooks/useAnonymizerConfig';
import css from './SettingsPanel.module.css';

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
  tier1: 'Tier 1 -- Standard (low false positive)',
  tier2: 'Tier 2 -- Keyword-anchored',
  tier3: 'Tier 3 -- High false positive risk',
};

const TIER_BADGE: Record<string, string> = {
  tier1: css.fpBadgeTier1,
  tier2: css.fpBadgeTier2,
  tier3: css.fpBadgeTier3,
};

interface AddPatternState {
  label: string;
  regex: string;
  error: string | null;
  open: boolean;
}

const SettingsPanel = memo(function SettingsPanel({
  settings,
  onUpdate,
  onReset,
  onClose,
  anonymizerConfig,
}: Props) {
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

  const handleNumberInput = useCallback(
    (key: keyof AppSettings, raw: string, fallback: number) => {
      const parsed = parseInt(raw.replace(/,/g, ''), 10);
      onUpdate(key, isNaN(parsed) || parsed < 1 ? fallback : parsed);
    },
    [onUpdate],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpandedDetectors((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
    <div className={css.backdrop} onClick={onClose}>
      <div className={css.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={css.header}>
          <span className={css.title}>Settings</span>
          <button className={css.closeBtn} onClick={onClose}>
            x
          </button>
        </div>

        {/* Tab bar */}
        <div className={css.tabs}>
          <button
            className={`${css.tab}${activeTab === 'general' ? ` ${css.tabActive}` : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button
            className={`${css.tab}${activeTab === 'pii' ? ` ${css.tabActive}` : ''}`}
            onClick={() => setActiveTab('pii')}
          >
            PII Anonymization
          </button>
        </div>

        <div className={css.body}>
          {/* General tab */}
          {activeTab === 'general' && (
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
              </div>
            </>
          )}

          {/* PII Anonymization tab */}
          {activeTab === 'pii' && (
            <div className={css.section}>
              {!config ? (
                <div className={css.labelHint}>Loading configuration...</div>
              ) : (
                <>
                  <div className={css.piiHint}>
                    Controls which patterns are detected when "Anonymize PII" is enabled
                    in the processor panel. Changes apply immediately to all future pipeline runs.
                  </div>

                  {/* Tier groups */}
                  {(['tier1', 'tier2', 'tier3'] as const).map((tier) => {
                    const detectors = config.detectors.filter((d) => d.tier === tier);
                    if (detectors.length === 0) return null;
                    return (
                      <div key={tier} className={css.tierGroup}>
                        <div className={css.tierGroupTitle}>{TIER_LABELS[tier]}</div>
                        {detectors.map((detector) => {
                          const isExpanded = expandedDetectors.has(detector.id);
                          const aps = getAddPatternState(detector.id);
                          return (
                            <div key={detector.id} className={css.detectorCard}>
                              <div className={css.detectorHeader}>
                                <input
                                  type="checkbox"
                                  checked={detector.enabled}
                                  onChange={(e) => toggleDetector(detector.id, e.target.checked)}
                                  title="Enable/disable this detector"
                                />
                                <span className={css.detectorLabel}>{detector.label}</span>
                                <span className={`${css.fpBadge} ${TIER_BADGE[tier] ?? ''}`}>
                                  {detector.fpHint}
                                </span>
                                <button
                                  className={css.expandBtn}
                                  onClick={() => toggleExpanded(detector.id)}
                                >
                                  {isExpanded ? '\u25B2' : '\u25BC'} {detector.patterns.length}{' '}
                                  pattern{detector.patterns.length !== 1 ? 's' : ''}
                                </button>
                              </div>

                              {isExpanded && (
                                <div className={css.patternList}>
                                  {detector.patterns.map((pattern, idx) => (
                                    <div key={idx} className={css.patternRow}>
                                      {pattern.builtin ? (
                                        <>
                                          <span className={css.builtinIcon} title="Built-in pattern">
                                            L
                                          </span>
                                          <div className={css.patternInfo}>
                                            <div className={css.patternLabel}>{pattern.label}</div>
                                            <code className={css.patternRegex}>{pattern.regex}</code>
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <input
                                            type="checkbox"
                                            checked={pattern.enabled}
                                            onChange={(e) =>
                                              togglePattern(detector.id, idx, e.target.checked)
                                            }
                                            title="Enable/disable this pattern"
                                          />
                                          <div className={css.patternInfo}>
                                            <div className={css.patternLabel}>{pattern.label}</div>
                                            <code className={css.patternRegex}>{pattern.regex}</code>
                                          </div>
                                          <button
                                            className={css.patternDelBtn}
                                            title="Remove pattern"
                                            onClick={() => removePattern(detector.id, idx)}
                                          >
                                            x
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  ))}

                                  {/* Add pattern form */}
                                  {aps.open ? (
                                    <div className={css.addPatternForm}>
                                      <div className={css.addPatternRow}>
                                        <input
                                          className={css.addPatternInput}
                                          placeholder="Label (e.g. Custom Email)"
                                          value={aps.label}
                                          onChange={(e) =>
                                            setAddPattern(detector.id, {
                                              label: e.target.value,
                                              error: null,
                                            })
                                          }
                                        />
                                        <input
                                          className={css.addPatternInput}
                                          placeholder="Regex pattern"
                                          value={aps.regex}
                                          spellCheck={false}
                                          onChange={(e) =>
                                            setAddPattern(detector.id, {
                                              regex: e.target.value,
                                              error: null,
                                            })
                                          }
                                        />
                                        <button
                                          className={css.addBtn}
                                          disabled={!aps.label.trim() || !aps.regex.trim()}
                                          onClick={() => handleAddPattern(detector.id)}
                                        >
                                          Add
                                        </button>
                                        <button
                                          className={`${css.addBtn} ${css.addBtnCancel}`}
                                          onClick={() =>
                                            setAddPattern(detector.id, {
                                              open: false,
                                              error: null,
                                            })
                                          }
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                      {aps.error && (
                                        <div className={css.addPatternError}>{aps.error}</div>
                                      )}
                                    </div>
                                  ) : (
                                    <button
                                      className={css.addPatternToggle}
                                      onClick={() =>
                                        setAddPattern(detector.id, { open: true })
                                      }
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
                  <div className={css.customSection}>
                    <div className={css.customSectionTitle}>Custom Detectors</div>
                    {config.detectors.filter((d) => !BUILTIN_IDS.has(d.id)).length === 0 && (
                      <div className={css.labelHint}>No custom detectors. Add one below.</div>
                    )}
                    {config.detectors
                      .filter((d) => !BUILTIN_IDS.has(d.id))
                      .map((d) => (
                        <div key={d.id} className={css.customEntry}>
                          <input
                            type="checkbox"
                            checked={d.enabled}
                            onChange={(e) => toggleDetector(d.id, e.target.checked)}
                          />
                          <span className={css.customEntryLabel}>{d.label}</span>
                          <button
                            className={css.customDelBtn}
                            title="Remove custom detector"
                            onClick={() => removeCustomDetector(d.id)}
                          >
                            x
                          </button>
                        </div>
                      ))}

                    <div className={css.addCustomForm}>
                      <div className={css.addPatternRow}>
                        <input
                          className={css.addPatternInput}
                          placeholder="Detector label (e.g. My Secret)"
                          value={addCustomState.label}
                          onChange={(e) =>
                            setAddCustomState((prev) => ({
                              ...prev,
                              label: e.target.value,
                              error: null,
                            }))
                          }
                        />
                        <input
                          className={css.addPatternInput}
                          placeholder="Regex pattern (e.g. SECRET-\w+)"
                          value={addCustomState.regex}
                          spellCheck={false}
                          onChange={(e) =>
                            setAddCustomState((prev) => ({
                              ...prev,
                              regex: e.target.value,
                              error: null,
                            }))
                          }
                        />
                        <button
                          className={css.addBtn}
                          disabled={!addCustomState.label.trim() || !addCustomState.regex.trim()}
                          onClick={handleAddCustomDetector}
                        >
                          Add
                        </button>
                      </div>
                      {addCustomState.error && (
                        <div className={css.addPatternError}>{addCustomState.error}</div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className={css.footer}>
          {activeTab === 'general' && (
            <button
              className={css.btnSecondary}
              onClick={onReset}
              title="Restore settings to their default values"
            >
              Reset to Defaults
            </button>
          )}
          <button className={css.btnPrimary} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
});

export default SettingsPanel;
